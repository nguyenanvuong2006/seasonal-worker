/**
 * PDF Overlay Engine — PDF template version lifecycle (PR2, management layer).
 *
 * Song song với merge_template_versions (HTML DRAFT/PUBLISHED) NHƯNG TÁCH RIÊNG:
 * pdf_template_versions giữ blank PDF nền + sha256 + page_layout. HTML DRAFT v3
 * KHÔNG bị đụng tới. Lifecycle: DRAFT → PUBLISHED → ARCHIVED (rollback = publish lại).
 *
 * Bất biến:
 *   - Chỉ 1 PUBLISHED/template (partial unique index + service tự archive version cũ).
 *   - Version PUBLISHED bất biến: không có hàm update version; chỉ đổi status.
 *   - Publish phải ATOMIC (transaction) và PHẢI verify blank PDF integrity trước.
 *   - ARCHIVED không thể âm thầm thành editable (không có transition → DRAFT).
 */

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { pdfTemplateVersions, type PdfTemplateVersion } from "@/db/schema";
import { getStorageProvider, type StorageProvider } from "@/lib/storage";
import { BlankPdfError, storeBlankPdf, verifyBlankPdfIntegrity } from "./pdf-storage.ts";

export const PDF_TEMPLATE_VERSION_STATUS = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  ARCHIVED: "ARCHIVED",
} as const;
export type PdfTemplateVersionStatus =
  (typeof PDF_TEMPLATE_VERSION_STATUS)[keyof typeof PDF_TEMPLATE_VERSION_STATUS];

/** Ma trận chuyển trạng thái hợp lệ (trừ các quy tắc đặc biệt ở publish/archive). */
export const PDF_VERSION_TRANSITIONS: Record<PdfTemplateVersionStatus, PdfTemplateVersionStatus[]> = {
  DRAFT: ["PUBLISHED", "ARCHIVED"],
  PUBLISHED: ["ARCHIVED"], // đạt được qua việc publish version khác (không archive trực tiếp)
  ARCHIVED: ["PUBLISHED"], // rollback
};

export function canTransition(
  from: PdfTemplateVersionStatus,
  to: PdfTemplateVersionStatus,
): boolean {
  return PDF_VERSION_TRANSITIONS[from].includes(to);
}

export class PdfTemplateVersionError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "PdfTemplateVersionError";
  }
}

export type NewPdfTemplateVersionInput = {
  blankPdfBytes: Uint8Array;
  blankPdfFileName?: string;
  sourceNote?: string | null;
};

export type VersionServiceOptions = { storage?: StorageProvider };

function nextVersionNumber(existing: { version: number }[]): number {
  const max = existing.reduce((m, v) => Math.max(m, v.version), 0);
  return max + 1;
}

/**
 * Tạo version DRAFT mới: upload blank PDF (versioned key, immutable) + lưu row.
 * Nếu insert DB thất bại → best-effort xoá object vừa upload (tránh orphan).
 */
export async function createPdfTemplateVersion(
  templateId: string,
  createdBy: string,
  input: NewPdfTemplateVersionInput,
  opts: VersionServiceOptions = {},
): Promise<PdfTemplateVersion> {
  const storage = opts.storage ?? getStorageProvider();

  const existing = await db
    .select({ version: pdfTemplateVersions.version })
    .from(pdfTemplateVersions)
    .where(eq(pdfTemplateVersions.templateId, templateId));
  const version = nextVersionNumber(existing);

  let stored;
  try {
    stored = await storeBlankPdf(templateId, version, input.blankPdfBytes, { storage });
  } catch (error) {
    if (error instanceof BlankPdfError) throw new PdfTemplateVersionError(error.message, error.status);
    throw error;
  }

  try {
    const [row] = await db
      .insert(pdfTemplateVersions)
      .values({
        templateId,
        version,
        status: PDF_TEMPLATE_VERSION_STATUS.DRAFT,
        pdfStorageKey: stored.key,
        sha256: stored.sha256,
        pageCount: stored.pageCount,
        pageLayout: stored.pageLayout,
        sourceNote: input.sourceNote ?? input.blankPdfFileName ?? null,
        createdBy,
      })
      .returning();
    return row;
  } catch (error) {
    try {
      await storage.delete(stored.key);
    } catch {
      /* best-effort */
    }
    throw error;
  }
}

/** Danh sách version (mới nhất trước). */
export async function listPdfTemplateVersions(templateId: string): Promise<PdfTemplateVersion[]> {
  return db
    .select()
    .from(pdfTemplateVersions)
    .where(eq(pdfTemplateVersions.templateId, templateId))
    .orderBy(desc(pdfTemplateVersions.version));
}

/** Lấy 1 version (scope theo template để chống IDOR). */
export async function getPdfTemplateVersion(
  templateId: string,
  versionId: string,
): Promise<PdfTemplateVersion | null> {
  const [row] = await db
    .select()
    .from(pdfTemplateVersions)
    .where(and(eq(pdfTemplateVersions.id, versionId), eq(pdfTemplateVersions.templateId, templateId)))
    .limit(1);
  return row ?? null;
}

/** Version PUBLISHED hiện tại của template (null nếu chưa có). */
export async function getPublishedPdfTemplateVersion(
  templateId: string,
): Promise<PdfTemplateVersion | null> {
  const [row] = await db
    .select()
    .from(pdfTemplateVersions)
    .where(
      and(
        eq(pdfTemplateVersions.templateId, templateId),
        eq(pdfTemplateVersions.status, PDF_TEMPLATE_VERSION_STATUS.PUBLISHED),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Publish version (atomic):
 *   1. Transition hợp lệ: DRAFT/ARCHIVED → PUBLISHED; PUBLISHED → idempotent.
 *   2. Gate integrity: blank PDF phải còn nguyên vẹn (SHA-256 + page_count khớp).
 *   3. Trong transaction: archive PUBLISHED cũ (superseded_by = version mới) rồi
 *      set version mới PUBLISHED. Partial unique index bảo vệ "chỉ 1 PUBLISHED".
 */
export async function publishPdfTemplateVersion(
  templateId: string,
  versionId: string,
  _createdBy: string,
  opts: VersionServiceOptions = {},
): Promise<PdfTemplateVersion> {
  const storage = opts.storage ?? getStorageProvider();

  const target = await getPdfTemplateVersion(templateId, versionId);
  if (!target) throw new PdfTemplateVersionError("PDF template version not found", 404);

  if (target.status === PDF_TEMPLATE_VERSION_STATUS.PUBLISHED) {
    return target; // idempotent
  }
  if (!canTransition(target.status as PdfTemplateVersionStatus, PDF_TEMPLATE_VERSION_STATUS.PUBLISHED)) {
    throw new PdfTemplateVersionError(
      `Không thể publish từ trạng thái ${target.status}.`,
      400,
    );
  }

  // Integrity gate — publish phải trỏ tới asset còn nguyên vẹn.
  const integrity = await verifyBlankPdfIntegrity(target.pdfStorageKey, target.sha256, {
    storage,
    expectedPageCount: target.pageCount,
  });
  if (!integrity.ok) {
    throw new PdfTemplateVersionError(
      `Blank PDF không còn nguyên vẹn (SHA-256 ${integrity.sha256.slice(0, 12)}… ≠ ${integrity.expectedSha256.slice(0, 12)}… hoặc page count không khớp).`,
      409,
    );
  }

  return db.transaction(async (tx) => {
    // Đọc lại trong transaction để tránh race.
    const [t] = await tx
      .select()
      .from(pdfTemplateVersions)
      .where(and(eq(pdfTemplateVersions.id, versionId), eq(pdfTemplateVersions.templateId, templateId)))
      .limit(1);
    if (!t) throw new PdfTemplateVersionError("PDF template version not found", 404);
    if (t.status === PDF_TEMPLATE_VERSION_STATUS.PUBLISHED) return t;

    const [previous] = await tx
      .select()
      .from(pdfTemplateVersions)
      .where(
        and(
          eq(pdfTemplateVersions.templateId, templateId),
          eq(pdfTemplateVersions.status, PDF_TEMPLATE_VERSION_STATUS.PUBLISHED),
        ),
      )
      .limit(1);
    if (previous) {
      await tx
        .update(pdfTemplateVersions)
        .set({
          status: PDF_TEMPLATE_VERSION_STATUS.ARCHIVED,
          archivedAt: new Date(),
          supersededBy: t.version,
          updatedAt: new Date(),
        })
        .where(eq(pdfTemplateVersions.id, previous.id));
    }

    const now = new Date();
    const [published] = await tx
      .update(pdfTemplateVersions)
      .set({
        status: PDF_TEMPLATE_VERSION_STATUS.PUBLISHED,
        publishedAt: now,
        archivedAt: null,
        supersededBy: null,
        updatedAt: now,
      })
      .where(eq(pdfTemplateVersions.id, versionId))
      .returning();
    return published;
  });
}

/**
 * Archive version (DRAFT → ARCHIVED). Từ chối archive version đang PUBLISHED
 * (phải publish version khác trước) — đúng mẫu merge_template_versions.
 */
export async function archivePdfTemplateVersion(
  templateId: string,
  versionId: string,
): Promise<PdfTemplateVersion> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(pdfTemplateVersions)
      .where(and(eq(pdfTemplateVersions.id, versionId), eq(pdfTemplateVersions.templateId, templateId)))
      .limit(1);
    if (!target) throw new PdfTemplateVersionError("PDF template version not found", 404);

    if (target.status === PDF_TEMPLATE_VERSION_STATUS.PUBLISHED) {
      throw new PdfTemplateVersionError(
        "Không thể archive version đang PUBLISHED — hãy publish version khác trước.",
        400,
      );
    }
    if (target.status === PDF_TEMPLATE_VERSION_STATUS.ARCHIVED) {
      return target; // idempotent
    }

    const [archived] = await tx
      .update(pdfTemplateVersions)
      .set({
        status: PDF_TEMPLATE_VERSION_STATUS.ARCHIVED,
        archivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(pdfTemplateVersions.id, versionId))
      .returning();
    return archived;
  });
}
