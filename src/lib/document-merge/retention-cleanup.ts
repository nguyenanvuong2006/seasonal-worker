/**
 * Document Merge — Retention cleanup (Phase 13).
 *
 * 1. Expired verified individual PDFs:
 *    CHỈ xoá file online khi retention_until <= now() AND archive_status = 'VERIFIED'.
 *    Nếu chưa VERIFIED → KHÔNG XOÁ DRIVE.
 * 2. Batch outputs (PDF tổng + ZIP) là TEMPORARY:
 *    xoá sau batchExpiresAt (7–30 ngày, ENV MERGE_JOB_BATCH_TTL_DAYS).
 *    Individual PDFs vẫn còn trong Document History.
 *
 * Non-destructive: chỉ xoá file đã hết hạn; mọi hành động ghi lại
 * online_deleted_at / deletion_reason / clear url.
 */

import { and, eq, isNotNull, lt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { documentHistory, mergeJobs } from "@/db/schema";
import { listExpiredVerifiedDocuments, markOnlineDeleted } from "./document-history.ts";
import { getStorageProvider } from "@/lib/storage/index.ts";

export type CleanupResult = {
  expiredVerifiedDeleted: number;
  expiredVerifiedSkipped: number;
  batchOutputsDeleted: number;
};

/**
 * Xoá PDF cá nhân hết hạn ĐÃ VERIFIED.
 * - expiredVerifiedDeleted: số file đã xoá Drive + đánh ONLINE_EXPIRED.
 * - expiredVerifiedSkipped: số file hết hạn nhưng CHƯA VERIFIED (KHÔNG xoá).
 */
export async function cleanupExpiredVerifiedDocuments(now: Date = new Date()): Promise<{
  deleted: number;
  skippedNotVerified: number;
}> {
  const storage = getStorageProvider();
  const expired = await listExpiredVerifiedDocuments(now);

  // Hết hạn nhưng chưa VERIFIED → KHÔNG xoá (báo cáo để biết).
  const notVerified = await db
    .select({ id: documentHistory.id })
    .from(documentHistory)
    .where(
      and(
        lt(documentHistory.retentionUntil, now),
        isNull(documentHistory.onlineDeletedAt),
        isNotNull(documentHistory.storageFileId),
      ),
    )
    .catch(() => []);

  let deleted = 0;
  for (const doc of expired) {
    try {
      if (doc.storageFileId) {
        await storage.delete(doc.storageFileId);
      }
      await markOnlineDeleted(doc.id, { reason: "RETENTION_EXPIRED", deletedAt: now });
      deleted += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "retention_delete_failed",
          historyId: doc.id,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        }),
      );
    }
  }

  return { deleted, skippedNotVerified: notVerified.length };
}

/** Xoá batch outputs (PDF tổng + ZIP) đã hết TTL. */
export async function cleanupExpiredBatchOutputs(now: Date = new Date()): Promise<number> {
  const storage = getStorageProvider();
  const expired = await db
    .select({
      id: mergeJobs.id,
      outputPdfFileId: mergeJobs.outputPdfFileId,
      outputZipFileId: mergeJobs.outputZipFileId,
    })
    .from(mergeJobs)
    .where(and(lt(mergeJobs.batchExpiresAt, now), isNotNull(mergeJobs.outputPdfFileId)));

  let deleted = 0;
  for (const job of expired) {
    try {
      if (job.outputPdfFileId) await storage.delete(job.outputPdfFileId);
      if (job.outputZipFileId) await storage.delete(job.outputZipFileId);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "batch_output_delete_failed",
          jobId: job.id,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        }),
      );
      continue;
    }
    await db
      .update(mergeJobs)
      .set({
        outputPdfUrl: null,
        outputZipUrl: null,
        outputPdfFileId: null,
        outputZipFileId: null,
        batchExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(mergeJobs.id, job.id));
    deleted += 1;
  }
  return deleted;
}

/** Chạy toàn bộ cleanup (dùng cho cron / route admin). */
export async function runRetentionCleanup(now: Date = new Date()): Promise<CleanupResult> {
  const expired = await cleanupExpiredVerifiedDocuments(now);
  const batchDeleted = await cleanupExpiredBatchOutputs(now);
  return {
    expiredVerifiedDeleted: expired.deleted,
    expiredVerifiedSkipped: expired.skippedNotVerified,
    batchOutputsDeleted: batchDeleted,
  };
}
