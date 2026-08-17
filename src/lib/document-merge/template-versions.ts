/**
 * Document Merge — Template versioning service (Phase 3).
 *
 * Mỗi template có chuỗi version:
 *   Đăng ký tập nghề: v1 ARCHIVED → v2 ARCHIVED → v3 PUBLISHED → v4 DRAFT
 *
 * Quy tắc:
 *   - Chỉ 1 version PUBLISHED/template (DB partial unique index bảo vệ).
 *   - Publish mới → version cũ bị ARCHIVED (superseded_by = version mới).
 *   - Publish SNAPSHOT mapping (merge_template_fields) vào mapping_snapshot
 *     → worker render deterministic; đổi mapping sau không ảnh hưởng PDF cũ.
 *   - Rollback = publish lại version cũ (version đang PUBLISHED bị ARCHIVED).
 *   - merge_templates.current_published_version = điểm vào render.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  mergeTemplateFields,
  mergeTemplates,
  mergeTemplateVersions,
  type MergeTemplateVersion,
} from "@/db/schema";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";

export const TEMPLATE_VERSION_STATUS = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  ARCHIVED: "ARCHIVED",
} as const;
export type TemplateVersionStatus = (typeof TEMPLATE_VERSION_STATUS)[keyof typeof TEMPLATE_VERSION_STATUS];

export class TemplateVersionError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "TemplateVersionError";
  }
}

export type NewTemplateVersionInput = {
  htmlBody?: string | null;
  printCss?: string | null;
  sourceDocxName?: string | null;
  retentionYears?: number | null;
};

/** Version tiếp theo = max(version) + 1 (mặc định 1). */
export function nextVersionNumber(existing: { version: number }[]): number {
  const maxVersion = existing.reduce((m, item) => Math.max(m, item.version), 0);
  return maxVersion + 1;
}

/** Validate retention years theo policy (1/2/3/5/10/none). */
export function normalizeRetentionYears(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const allowed = [1, 2, 3, 5, 10];
  return allowed.includes(value) ? value : 3;
}

/** Tạo version DRAFT mới cho template. */
export async function createTemplateVersion(
  templateId: string,
  createdBy: string,
  input: NewTemplateVersionInput = {},
): Promise<MergeTemplateVersion> {
  const existing = await db
    .select({ version: mergeTemplateVersions.version })
    .from(mergeTemplateVersions)
    .where(eq(mergeTemplateVersions.templateId, templateId));

  const [version] = await db
    .insert(mergeTemplateVersions)
    .values({
      templateId,
      version: nextVersionNumber(existing),
      status: TEMPLATE_VERSION_STATUS.DRAFT,
      htmlBody: input.htmlBody ?? null,
      printCss: input.printCss ?? null,
      sourceDocxName: input.sourceDocxName ?? null,
      retentionYears: normalizeRetentionYears(input.retentionYears),
      createdBy,
    })
    .returning();

  return version;
}

/** Lấy danh sách version (mới nhất trước). */
export async function listTemplateVersions(templateId: string): Promise<MergeTemplateVersion[]> {
  return db
    .select()
    .from(mergeTemplateVersions)
    .where(eq(mergeTemplateVersions.templateId, templateId))
    .orderBy(desc(mergeTemplateVersions.version));
}

/** Lấy version PUBLISHED hiện tại (điểm vào render HTML_PDF). */
export async function getPublishedTemplateVersion(templateId: string): Promise<MergeTemplateVersion | null> {
  const [version] = await db
    .select()
    .from(mergeTemplateVersions)
    .where(
      and(
        eq(mergeTemplateVersions.templateId, templateId),
        eq(mergeTemplateVersions.status, TEMPLATE_VERSION_STATUS.PUBLISHED),
      ),
    )
    .limit(1);
  return version ?? null;
}

/**
 * Publish một version.
 * - Version phải tồn tại và thuộc template.
 * - Nếu version đã PUBLISHED (rollback cùng version) → no-op trả về version.
 * - Version PUBLISHED cũ → ARCHIVED + superseded_by = version mới.
 * - Snapshot mapping hiện tại (không-orphaned) vào mapping_snapshot.
 * - Cập nhật merge_templates.current_published_version.
 */
export async function publishTemplateVersion(
  templateId: string,
  versionId: string,
  createdBy: string,
): Promise<MergeTemplateVersion> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(mergeTemplateVersions)
      .where(and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)))
      .limit(1);

    if (!target) {
      throw new TemplateVersionError("Template version not found", 404);
    }
    if (target.status === TEMPLATE_VERSION_STATUS.PUBLISHED) {
      return target; // idempotent
    }
    if (target.htmlBody == null || target.htmlBody.trim().length === 0) {
      throw new TemplateVersionError("Không thể publish version chưa có nội dung HTML.", 400);
    }

    // Snapshot mapping hiện tại (chỉ placeholder không orphan).
    const fields = await tx
      .select()
      .from(mergeTemplateFields)
      .where(and(eq(mergeTemplateFields.templateId, templateId), eq(mergeTemplateFields.isOrphaned, false)));

    const mappingSnapshot = fields.map((field) => ({
      placeholder: field.placeholder,
      sourceType: field.sourceType,
      sourceEntity: field.sourceEntity,
      sourceField: field.sourceField,
      sourcePath: field.sourcePath,
      optionValue: field.optionValue,
      formatType: field.formatType,
      fallbackValue: field.fallbackValue,
      isRequired: field.isRequired,
    }));

    // Version PUBLISHED cũ → ARCHIVED.
    const [previous] = await tx
      .select()
      .from(mergeTemplateVersions)
      .where(
        and(
          eq(mergeTemplateVersions.templateId, templateId),
          eq(mergeTemplateVersions.status, TEMPLATE_VERSION_STATUS.PUBLISHED),
        ),
      )
      .limit(1);

    if (previous) {
      await tx
        .update(mergeTemplateVersions)
        .set({
          status: TEMPLATE_VERSION_STATUS.ARCHIVED,
          archivedAt: new Date(),
          supersededBy: target.version,
          updatedAt: new Date(),
        })
        .where(eq(mergeTemplateVersions.id, previous.id));
    }

    const now = new Date();
    const [published] = await tx
      .update(mergeTemplateVersions)
      .set({
        status: TEMPLATE_VERSION_STATUS.PUBLISHED,
        publishedAt: now,
        archivedAt: null,
        supersededBy: null,
        mappingSnapshot,
        updatedAt: now,
      })
      .where(eq(mergeTemplateVersions.id, versionId))
      .returning();

    await tx
      .update(mergeTemplates)
      .set({ currentPublishedVersion: published.version, updatedAt: now })
      .where(eq(mergeTemplates.id, templateId));

    return published;
  });
}

/** Archive một version (không được archive version đang PUBLISHED). */
export async function archiveTemplateVersion(
  templateId: string,
  versionId: string,
): Promise<MergeTemplateVersion> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(mergeTemplateVersions)
      .where(and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)))
      .limit(1);

    if (!target) {
      throw new TemplateVersionError("Template version not found", 404);
    }
    if (target.status === TEMPLATE_VERSION_STATUS.PUBLISHED) {
      throw new TemplateVersionError("Không thể archive version đang PUBLISHED — hãy publish version khác trước.", 400);
    }
    if (target.status === TEMPLATE_VERSION_STATUS.ARCHIVED) {
      return target;
    }

    const [archived] = await tx
      .update(mergeTemplateVersions)
      .set({ status: TEMPLATE_VERSION_STATUS.ARCHIVED, archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(mergeTemplateVersions.id, versionId))
      .returning();

    return archived;
  });
}

/**
 * Rollback: publish lại version cũ (ARCHIVED/DRAFT) làm version hiện hành.
 * Là alias của publishTemplateVersion — giữ tên riêng cho rõ nghiệp vụ.
 */
export async function rollbackTemplateVersion(
  templateId: string,
  versionId: string,
  createdBy: string,
): Promise<MergeTemplateVersion> {
  return publishTemplateVersion(templateId, versionId, createdBy);
}

/** Danh sách placeholder trong html_body của version (scanner hoạt động không cần Google Docs). */
export function scanPlaceholdersInVersionHtml(htmlBody: string): string[] {
  return extractUniquePlaceholders(htmlBody ?? "");
}
