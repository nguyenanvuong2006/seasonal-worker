/**
 * Document Merge — Document History service (Phase 2).
 *
 * Mỗi lần 1 PDF được tạo → TẠO 1 RECORD RIÊNG (không overwrite).
 * Candidate A đăng ký 3 lần → 3 records (2026/2027/2028) cùng tồn tại
 * cho tới khi retention lifecycle của TỪNG record kết thúc.
 *
 * Vòng đời archive:
 *   ONLINE → ARCHIVED → VERIFIED → ONLINE_EXPIRED
 *   (ARCHIVE_VERIFY_FAILED nếu checksum lệch — GIỮ file Drive, tải lại sau)
 *
 * CHỈ xoá file online khi retention_until <= now() AND archive_status='VERIFIED'.
 */

import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "../../db";
import { documentHistory, mergeJobRecords, type DocumentHistory } from "../../db/schema";
import { computeRetentionUntil, type RetentionPolicy } from "./retention.ts";

export const ARCHIVE_STATUS = {
  ONLINE: "ONLINE",
  ARCHIVED: "ARCHIVED",
  VERIFIED: "VERIFIED",
  ARCHIVE_VERIFY_FAILED: "ARCHIVE_VERIFY_FAILED",
  ONLINE_EXPIRED: "ONLINE_EXPIRED",
} as const;
export type ArchiveStatus = (typeof ARCHIVE_STATUS)[keyof typeof ARCHIVE_STATUS];

export const DELETE_REASON = {
  RETENTION_EXPIRED: "RETENTION_EXPIRED",
  BATCH_TTL: "BATCH_TTL",
  MANUAL: "MANUAL",
} as const;

export type NewDocumentHistoryInput = {
  candidateId?: string | null;
  applicationId?: string | null;
  mergeJobId?: string | null;
  mergeJobRecordId?: string | null;
  templateId?: string | null;
  templateVersion?: number | null;
  documentType?: string | null;
  filename: string;
  storageProvider: string;
  storageFileId?: string | null;
  fileSize?: number | null;
  sha256?: string | null;
  retentionYears?: number | null;
  retentionSource?: RetentionPolicy["source"];
  createdBy?: string | null;
};

/**
 * Ghi 1 record Document History cho 1 PDF vừa tạo.
 * - retention_until = generated_at + retention_years (snapshot).
 * - trả về record; caller có thể liên kết merge_job_records.document_history_id.
 */
export async function createDocumentHistory(input: NewDocumentHistoryInput): Promise<DocumentHistory> {
  const generatedAt = new Date();
  const fallbackYears = input.retentionYears === undefined ? 3 : input.retentionYears;
  const { retentionUntil, policy } = computeRetentionUntil(generatedAt, input.retentionYears, fallbackYears);

  const [record] = await db
    .insert(documentHistory)
    .values({
      candidateId: input.candidateId ?? null,
      applicationId: input.applicationId ?? null,
      mergeJobId: input.mergeJobId ?? null,
      mergeJobRecordId: input.mergeJobRecordId ?? null,
      templateId: input.templateId ?? null,
      templateVersion: input.templateVersion ?? null,
      documentType: input.documentType ?? null,
      generatedAt,
      filename: input.filename,
      storageProvider: input.storageProvider,
      storageFileId: input.storageFileId ?? null,
      fileSize: input.fileSize ?? null,
      sha256: input.sha256 ?? null,
      retentionUntil,
      retentionPolicySnapshot: { years: policy.years, source: policy.source },
      archiveStatus: ARCHIVE_STATUS.ONLINE,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  return record;
}

/** Lịch sử theo ứng viên (mới nhất trước) — Document History tab. */
export async function listDocumentHistoryByApplication(applicationId: string): Promise<DocumentHistory[]> {
  return db
    .select()
    .from(documentHistory)
    .where(eq(documentHistory.applicationId, applicationId))
    .orderBy(desc(documentHistory.generatedAt));
}

/** Lịch sử theo merge job. */
export async function listDocumentHistoryByJob(mergeJobId: string): Promise<DocumentHistory[]> {
  return db
    .select()
    .from(documentHistory)
    .where(eq(documentHistory.mergeJobId, mergeJobId))
    .orderBy(desc(documentHistory.generatedAt));
}

/**
 * Danh sách PDF cần archive: chưa VERIFIED (ONLINE / ARCHIVED / ARCHIVE_VERIFY_FAILED).
 * Archive Agent dùng API này (phân trang) — resume = không tải lại file VERIFIED.
 */
export async function listDocumentsPendingArchive(
  opts: { limit?: number; offset?: number } = {},
): Promise<DocumentHistory[]> {
  const { limit = 200, offset = 0 } = opts;
  return db
    .select()
    .from(documentHistory)
    .where(
      and(
        or(
          eq(documentHistory.archiveStatus, ARCHIVE_STATUS.ONLINE),
          eq(documentHistory.archiveStatus, ARCHIVE_STATUS.ARCHIVED),
          eq(documentHistory.archiveStatus, ARCHIVE_STATUS.ARCHIVE_VERIFY_FAILED),
        ),
        isNull(documentHistory.onlineDeletedAt),
      ),
    )
    .orderBy(desc(documentHistory.generatedAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Archive Agent xác nhận đã tải file xuống HDD/NAS.
 * @param sha256Match true nếu SHA-256 local == sha256 trong DB → VERIFIED.
 *                    false nếu lệch → ARCHIVE_VERIFY_FAILED (GIỮ file Drive).
 */
export async function verifyArchive(
  historyId: string,
  input: { sha256Match: boolean; archivePath: string; archiveSha256?: string | null },
): Promise<DocumentHistory> {
  const now = new Date();
  const [record] = await db
    .update(documentHistory)
    .set({
      archiveStatus: input.sha256Match ? ARCHIVE_STATUS.VERIFIED : ARCHIVE_STATUS.ARCHIVE_VERIFY_FAILED,
      archivedAt: input.sha256Match ? now : undefined,
      archiveVerifiedAt: input.sha256Match ? now : null,
      archivePath: input.archivePath,
      archiveSha256: input.archiveSha256 ?? null,
      updatedAt: now,
    })
    .where(eq(documentHistory.id, historyId))
    .returning();
  return record;
}

/**
 * Danh sách PDF đủ điều kiện xoá online:
 * retention_until <= now() AND archive_status = 'VERIFIED'.
 * Retention cleanup CHỈ xoá khi cả 2 điều kiện thoả.
 */
export async function listExpiredVerifiedDocuments(now: Date = new Date()): Promise<DocumentHistory[]> {
  return db
    .select()
    .from(documentHistory)
    .where(
      and(
        eq(documentHistory.archiveStatus, ARCHIVE_STATUS.VERIFIED),
        lt(documentHistory.retentionUntil, now),
        isNull(documentHistory.onlineDeletedAt),
      ),
    )
    .orderBy(documentHistory.retentionUntil)
    .limit(500);
}

/** Đánh dấu đã xoá online (sau khi đã VERIFIED + hết hạn). */
export async function markOnlineDeleted(
  historyId: string,
  input: { reason?: string; deletedAt?: Date } = {},
): Promise<DocumentHistory> {
  const [record] = await db
    .update(documentHistory)
    .set({
      archiveStatus: ARCHIVE_STATUS.ONLINE_EXPIRED,
      onlineDeletedAt: input.deletedAt ?? new Date(),
      deletionReason: input.reason ?? DELETE_REASON.RETENTION_EXPIRED,
      updatedAt: new Date(),
    })
    .where(eq(documentHistory.id, historyId))
    .returning();
  return record;
}

/** Liên kết merge_job_records → document_history (sau khi ghi history). */
export async function linkRecordToHistory(recordId: string, historyId: string): Promise<void> {
  await db
    .update(mergeJobRecords)
    .set({ documentHistoryId: historyId })
    .where(eq(mergeJobRecords.id, recordId));
}

/** Batch liên kết record → history (khi worker ghi history sau upload). */
export async function linkRecordsToHistory(
  pairs: { recordId: string; historyId: string }[],
): Promise<void> {
  if (pairs.length === 0) return;
  await db
    .update(mergeJobRecords)
    .set({
      documentHistoryId: undefined,
    })
    .where(
      inArray(
        mergeJobRecords.id,
        pairs.map((p) => p.recordId),
      ),
    );
  for (const pair of pairs) {
    await db
      .update(mergeJobRecords)
      .set({ documentHistoryId: pair.historyId })
      .where(eq(mergeJobRecords.id, pair.recordId));
  }
}
