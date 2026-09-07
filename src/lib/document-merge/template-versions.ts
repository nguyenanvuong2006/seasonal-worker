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
 *   - Clone ("Tạo bản nháp từ phiên bản này") = CREATE version DRAFT mới copy
 *     html/css từ version nguồn; version nguồn (kể cả PUBLISHED) bất biến,
 *     DRAFT mới mapping_snapshot = [] cho tới khi publish.
 *   - Sửa HTML/CSS chỉ áp dụng cho DRAFT (updateTemplateVersionDraft).
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  documentHistory,
  mergeTemplateFields,
  mergeTemplates,
  mergeTemplateVersions,
  type MergeTemplateVersion,
} from "@/db/schema";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";
import { DEFAULT_PAGE_MARGINS, type PageMargins } from "./html-renderer.ts";

/**
 * A4 PRINT MARGIN VALIDATION (Phase 4) — no negative margin, no margin large
 * enough to make the printable area unusable. Mirrors the DB-level CHECK
 * constraint (migrations/2026-09-07-document-merge-template-margins.sql) as
 * the primary, operator-facing validation layer (the DB constraint is
 * defense in depth, not the first line of defence).
 */
export const MARGIN_MM_MIN = 0;
export const MARGIN_MM_MAX = 60;
/** Leaves at least this much usable printable width/height (mm) out of 210x297. */
const MIN_USABLE_WIDTH_MM = 30;
const MIN_USABLE_HEIGHT_MM = 40;

export type PartialPageMargins = Partial<{
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
}>;

/**
 * Validate margin inputs. Returns a human-readable error, or null if valid.
 * Only validates fields that are actually present in `input` — callers merge
 * against existing/default values first when only some fields are supplied.
 */
export function validateMargins(margins: {
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
}): string | null {
  const entries: [string, number][] = [
    ["Top", margins.marginTopMm],
    ["Bottom", margins.marginBottomMm],
    ["Left", margins.marginLeftMm],
    ["Right", margins.marginRightMm],
  ];
  for (const [label, value] of entries) {
    if (!Number.isInteger(value)) {
      return `Margin ${label} phải là số nguyên (mm).`;
    }
    if (value < MARGIN_MM_MIN || value > MARGIN_MM_MAX) {
      return `Margin ${label} phải trong khoảng ${MARGIN_MM_MIN}-${MARGIN_MM_MAX}mm.`;
    }
  }
  const usableWidth = 210 - margins.marginLeftMm - margins.marginRightMm;
  const usableHeight = 297 - margins.marginTopMm - margins.marginBottomMm;
  if (usableWidth < MIN_USABLE_WIDTH_MM) {
    return `Margin trái + phải quá lớn — vùng in được chỉ còn ${usableWidth}mm (tối thiểu ${MIN_USABLE_WIDTH_MM}mm).`;
  }
  if (usableHeight < MIN_USABLE_HEIGHT_MM) {
    return `Margin trên + dưới quá lớn — vùng in được chỉ còn ${usableHeight}mm (tối thiểu ${MIN_USABLE_HEIGHT_MM}mm).`;
  }
  return null;
}

/** Normalize an optional margin patch against existing/default values, then validate. */
export function resolveAndValidateMargins(
  patch: PartialPageMargins,
  existing: { marginTopMm: number; marginBottomMm: number; marginLeftMm: number; marginRightMm: number } = {
    marginTopMm: DEFAULT_PAGE_MARGINS.topMm,
    marginBottomMm: DEFAULT_PAGE_MARGINS.bottomMm,
    marginLeftMm: DEFAULT_PAGE_MARGINS.leftMm,
    marginRightMm: DEFAULT_PAGE_MARGINS.rightMm,
  },
): { marginTopMm: number; marginBottomMm: number; marginLeftMm: number; marginRightMm: number } {
  const resolved = {
    marginTopMm: patch.marginTopMm ?? existing.marginTopMm,
    marginBottomMm: patch.marginBottomMm ?? existing.marginBottomMm,
    marginLeftMm: patch.marginLeftMm ?? existing.marginLeftMm,
    marginRightMm: patch.marginRightMm ?? existing.marginRightMm,
  };
  const error = validateMargins(resolved);
  if (error) {
    throw new TemplateVersionError(error, 400);
  }
  return resolved;
}

/** Row margins → the PageMargins shape html-renderer.ts expects. */
export function toPageMargins(row: {
  marginTopMm?: number | null;
  marginBottomMm?: number | null;
  marginLeftMm?: number | null;
  marginRightMm?: number | null;
}): PageMargins {
  return {
    topMm: row.marginTopMm ?? DEFAULT_PAGE_MARGINS.topMm,
    bottomMm: row.marginBottomMm ?? DEFAULT_PAGE_MARGINS.bottomMm,
    leftMm: row.marginLeftMm ?? DEFAULT_PAGE_MARGINS.leftMm,
    rightMm: row.marginRightMm ?? DEFAULT_PAGE_MARGINS.rightMm,
  };
}

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
} & PartialPageMargins;

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

  const margins = resolveAndValidateMargins(input);

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
      ...margins,
      createdBy,
    })
    .returning();

  return version;
}

/** Số lần tính lại version number khi hai admin clone gần như cùng lúc. */
export const CLONE_VERSION_MAX_ATTEMPTS = 5;

/**
 * Postgres unique_violation (23505) — drizzle có thể bọc lỗi pg trong
 * `cause`, nên kiểm tra cả hai tầng.
 */
export function isUniqueViolation(error: unknown): boolean {
  const codeOf = (candidate: unknown): unknown =>
    typeof candidate === "object" && candidate !== null
      ? (candidate as { code?: unknown }).code
      : undefined;
  return codeOf(error) === "23505" || codeOf((error as { cause?: unknown })?.cause) === "23505";
}

export type ClonedTemplateVersion = MergeTemplateVersion & {
  /** Version đã được clone (nguồn) — để UI hiển thị "đã tạo v9 từ v8". */
  sourceVersionNumber: number;
};

/**
 * "Tạo bản nháp từ phiên bản này" — clone MỘT version hiện có (thường là
 * PUBLISHED) thành version DRAFT MỚI để operator chỉnh HTML/CSS.
 *
 * INVARIANTS (có regression test riêng — template-version-clone.test.ts):
 *   - Version nguồn KHÔNG BAO GIỜ bị UPDATE/DELETE (clone = CREATE NEW ROW).
 *   - Chỉ copy nội dung render: htmlBody, printCss, sourceDocxName,
 *     retentionYears, và 4 cột margin (marginTopMm/BottomMm/LeftMm/RightMm —
 *     Phase 4). KHÔNG copy id/version/status/publishedAt/archivedAt/
 *     supersededBy/createdAt.
 *   - Version mới: status = DRAFT, publishedAt = NULL, archivedAt = NULL.
 *   - mapping_snapshot của version mới PHẢI = [] — DRAFT resolve CURRENT
 *     non-orphaned merge_template_fields khi Preview (PR #99); snapshot chỉ
 *     được freeze ở publishTemplateVersion. KHÔNG copy frozen snapshot của
 *     version nguồn.
 *   - KHÔNG đổi merge_templates.current_published_version, KHÔNG publish,
 *     KHÔNG tạo merge job / document_history, KHÔNG dispatch worker.
 *
 * CONCURRENCY: version number = max(version)+1 tính TRONG transaction; nếu hai
 * admin tạo cùng lúc, unique index (template_id, version) khiến bên thua nhận
 * 23505 → retry với số version mới (KHÔNG overwrite version đã tồn tại).
 * Client không bao giờ gửi version number hay HTML nguồn — server tự load từ DB.
 */
export async function cloneTemplateVersion(
  templateId: string,
  versionId: string,
  createdBy: string,
): Promise<ClonedTemplateVersion> {
  // Load version nguồn trực tiếp từ DB, cross-check templateId từ URL —
  // versionId thuộc template khác bị từ chối như "not found" (404).
  const [source] = await db
    .select()
    .from(mergeTemplateVersions)
    .where(and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)))
    .limit(1);

  if (!source) {
    throw new TemplateVersionError("Template version not found", 404);
  }
  if (source.htmlBody == null || source.htmlBody.trim().length === 0) {
    throw new TemplateVersionError(
      "Không thể tạo bản nháp từ version chưa có nội dung HTML — hãy chọn version đã có HTML.",
      400,
    );
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= CLONE_VERSION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        // max(version) + 1 tính trong transaction theo DB hiện tại —
        // không bao giờ tin version number do client gửi.
        const existing = await tx
          .select({ version: mergeTemplateVersions.version })
          .from(mergeTemplateVersions)
          .where(eq(mergeTemplateVersions.templateId, templateId));

        const [cloned] = await tx
          .insert(mergeTemplateVersions)
          .values({
            templateId,
            version: nextVersionNumber(existing),
            status: TEMPLATE_VERSION_STATUS.DRAFT,
            // Nội dung render được copy nguyên vẹn từ version nguồn…
            htmlBody: source.htmlBody,
            printCss: source.printCss,
            sourceDocxName: source.sourceDocxName,
            retentionYears: source.retentionYears,
            // A4 print margins (Phase 4) — copied verbatim, same as htmlBody/
            // printCss; editable afterwards since the clone starts DRAFT.
            marginTopMm: source.marginTopMm,
            marginBottomMm: source.marginBottomMm,
            marginLeftMm: source.marginLeftMm,
            marginRightMm: source.marginRightMm,
            // …nhưng mapping_snapshot KHÔNG copy: DRAFT = [] cho tới khi publish.
            mappingSnapshot: [],
            // Lifecycle fields thuộc về version mới.
            publishedAt: null,
            archivedAt: null,
            supersededBy: null,
            createdBy,
          })
          .returning();

        return { ...cloned, sourceVersionNumber: source.version };
      });
    } catch (error) {
      // Hai admin clone cùng lúc → cùng tính ra version N; unique index
      // (template_id, version) từ chối bên về sau → tính lại số mới.
      // Lỗi khác (không phải xung đột số version) được ném thẳng.
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  // Hết lượt thử vẫn xung đột số version — trả conflict có kiểm soát cho
  // client; chi tiết lỗi driver chỉ ghi log server-side, không lộ ra ngoài.
  console.error(
    `[cloneTemplateVersion] unique-version conflict not resolved after ${CLONE_VERSION_MAX_ATTEMPTS} attempts (templateId=${templateId}, sourceVersion=${source.version}):`,
    lastError,
  );
  throw new TemplateVersionError(
    `Không tạo được version mới sau ${CLONE_VERSION_MAX_ATTEMPTS} lần thử do xung đột số phiên bản — vui lòng thử lại.`,
    409,
  );
}

export type UpdateTemplateVersionDraftInput = {
  htmlBody: string;
  printCss?: string | null;
} & PartialPageMargins;

/**
 * Sửa HTML/CSS (và margin A4 — Phase 4) của một version DRAFT. Server-side
 * guard — KHÔNG chỉ chặn ở UI:
 *   - Version phải tồn tại và thuộc template (id + templateId cross-check).
 *   - Chỉ DRAFT được UPDATE; PUBLISHED/ARCHIVED → 409 (kể cả khi editor đã mở
 *     từ trước và version vừa được ai đó publish).
 *   - UPDATE mang điều kiện status='DRAFT' ngay trong WHERE, nên kể cả race
 *     giữa SELECT và UPDATE, row đã rời DRAFT không bao giờ bị ghi đè.
 *   - KHÔNG đổi status/mapping_snapshot/publishedAt/archivedAt — bản PUBLISHED
 *     immutable.
 */
export async function updateTemplateVersionDraft(
  templateId: string,
  versionId: string,
  input: UpdateTemplateVersionDraftInput,
): Promise<MergeTemplateVersion> {
  const [target] = await db
    .select()
    .from(mergeTemplateVersions)
    .where(and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)))
    .limit(1);

  if (!target) {
    throw new TemplateVersionError("Template version not found", 404);
  }
  if (target.status !== TEMPLATE_VERSION_STATUS.DRAFT) {
    throw new TemplateVersionError(
      `Chỉ version DRAFT mới được sửa HTML/CSS. Version v${target.version} hiện đang ${target.status} và là bất biến.`,
      409,
    );
  }

  // target.marginXMm falls back to the canonical default when a row predates
  // the margin columns (defensive — the DB column itself is NOT NULL DEFAULT).
  const margins = resolveAndValidateMargins(input, {
    marginTopMm: target.marginTopMm ?? DEFAULT_PAGE_MARGINS.topMm,
    marginBottomMm: target.marginBottomMm ?? DEFAULT_PAGE_MARGINS.bottomMm,
    marginLeftMm: target.marginLeftMm ?? DEFAULT_PAGE_MARGINS.leftMm,
    marginRightMm: target.marginRightMm ?? DEFAULT_PAGE_MARGINS.rightMm,
  });

  const [updated] = await db
    .update(mergeTemplateVersions)
    .set({
      htmlBody: input.htmlBody,
      printCss: input.printCss ?? null,
      ...margins,
      updatedAt: new Date(),
    })
    // Guard trong câu UPDATE: chỉ ghi nếu row VẪN là DRAFT tại thời điểm ghi.
    .where(
      and(
        eq(mergeTemplateVersions.id, versionId),
        eq(mergeTemplateVersions.templateId, templateId),
        eq(mergeTemplateVersions.status, TEMPLATE_VERSION_STATUS.DRAFT),
      ),
    )
    .returning();

  // Row không còn DRAFT giữa SELECT và UPDATE (admin khác vừa publish) → reject.
  if (!updated) {
    throw new TemplateVersionError(
      "Version đã không còn là DRAFT (có thể vừa được publish/archive) — không thể lưu. Hãy tải lại danh sách phiên bản.",
      409,
    );
  }
  return updated;
}

export type DeletedTemplateDraftVersion = {
  id: string;
  templateId: string;
  version: number;
};

/**
 * XOÁ VĨNH VIỄN một version DRAFT ("Xóa bản nháp"). Server-side guard —
 * KHÔNG chỉ chặn ở UI, API gọi trực tiếp cũng bị từ chối:
 *
 *   - Version phải tồn tại và thuộc template (id + templateId cross-check
 *     trong WHERE — versionId của template khác bị coi là 404).
 *   - CHỈ DRAFT được DELETE: version được RE-READ trong transaction ngay
 *     trước DELETE, và câu DELETE mang điều kiện status='DRAFT' ngay trong
 *     WHERE — nếu row rồi DRAFT giữa SELECT và DELETE (race publish/archive)
 *     thì 0 row khớp → fail closed 409. PUBLISHED/ARCHIVED luôn bị từ chối
 *     (immutable, cần giữ để truy vết).
 *   - REFERENCE GUARD (fail closed, audit FK trước khi DELETE):
 *       · document_history lưu (template_id, template_version) dạng GIÁ TRỊ
 *         (không FK) — bản ghi tuân thủ/retention phải BẢO TOÀN tuyệt đối.
 *         Về lý thuyết DRAFT không bao giờ tạo document_history (chỉ version
 *         PUBLISHED mới được batch render; không có đường chuyển PUBLISHED →
 *         DRAFT), nhưng nếu dữ liệu bất thường khiến 1 row history trỏ tới
 *         version này → chặn xoá, trả lỗi operator-friendly, KHÔNG cascade
 *         mù quáng.
 *       · merge_jobs / merge_job_records chỉ tham chiếu template_id (không
 *         có cột version); nội dung render được snapshot VÀO job metadata lúc
 *         tạo job và CHỈ từ version PUBLISHED (async-job.ts lọc
 *         status='PUBLISHED'; worker render từ snapshot, không tra lại bảng
 *         versions) → DRAFT không thể bị job nào tham chiếu. Không cần check
 *         thêm ở đây — đây là kết luận audit, không phải giả định.
 *   - FK audit: KHÔNG bảng nào có FK trỏ TỚI merge_template_versions.id
 *     (grep toàn bộ schema.sql + migrations: 0 REFERENCES). DELETE chỉ đụng
 *     đúng 1 row version; không trigger/cascade nào khác tồn tại.
 *
 * BẤT BIẾN SAU DELETE (có regression test):
 *   - KHÔNG đổi merge_templates.current_published_version (0 ghi vào
 *     merge_templates) → version PUBLISHED hiện hành bất động.
 *   - KHÔNG đụng merge_template_fields — mapping là TEMPLATE-GLOBAL, dùng
 *     chung cho mọi version; xoá 1 DRAFT không xoá mapping rows dùng chung.
 *   - KHÔNG đụng mapping_snapshot / PDF / job / history của version khác
 *     (DELETE duy nhất scope theo id của version mục tiêu).
 *   - KHÔNG publish, KHÔNG archive version nào khác.
 */
export async function deleteTemplateDraftVersion(
  templateId: string,
  versionId: string,
): Promise<DeletedTemplateDraftVersion> {
  return db.transaction(async (tx) => {
    // RE-READ version trong transaction ngay trước DELETE (fail closed nếu
    // status đã đổi so với lúc UI tải danh sách).
    const [target] = await tx
      .select()
      .from(mergeTemplateVersions)
      .where(and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)))
      .limit(1);

    if (!target) {
      throw new TemplateVersionError("Template version not found", 404);
    }
    if (target.status !== TEMPLATE_VERSION_STATUS.DRAFT) {
      throw new TemplateVersionError(
        `Chỉ version DRAFT mới được xoá vĩnh viễn. Version v${target.version} hiện đang ${target.status} và là bất biến (phải giữ lại để truy vết).`,
        409,
      );
    }

    // Reference guard — document_history là bản ghi tuân thủ, phải bảo toàn.
    const [usedInHistory] = await tx
      .select({ id: documentHistory.id })
      .from(documentHistory)
      .where(and(eq(documentHistory.templateId, templateId), eq(documentHistory.templateVersion, target.version)))
      .limit(1);
    if (usedInHistory) {
      throw new TemplateVersionError(
        `Version v${target.version} đã từng được dùng để tạo tài liệu (có trong document_history) — không thể xoá vĩnh viễn vì sẽ làm mất khả năng truy vết. Hãy Lưu trữ (Archive) thay vì Xoá.`,
        409,
      );
    }

    // DELETE với guard status='DRAFT' NGAY trong WHERE — dù row rồi DRAFT
    // giữa SELECT và DELETE (admin khác vừa publish/archive) thì 0 row khớp,
    // fail closed, KHÔNG xoá nhầm.
    const [deleted] = await tx
      .delete(mergeTemplateVersions)
      .where(
        and(
          eq(mergeTemplateVersions.id, versionId),
          eq(mergeTemplateVersions.templateId, templateId),
          eq(mergeTemplateVersions.status, TEMPLATE_VERSION_STATUS.DRAFT),
        ),
      )
      .returning({ id: mergeTemplateVersions.id, version: mergeTemplateVersions.version });

    if (!deleted) {
      throw new TemplateVersionError(
        "Version đã không còn là DRAFT (có thể vừa được publish/archive) — không thể xoá. Hãy tải lại danh sách phiên bản.",
        409,
      );
    }

    return { id: deleted.id, templateId, version: deleted.version };
  });
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
 * Chọn template dùng cho merge/verify bằng engine HTML_PDF: active + đã có
 * version PUBLISHED (tạo sớm nhất trước). Trả null nếu chưa có template nào
 * sẵn sàng — nghĩa là cần Import DOCX/tạo DRAFT rồi Publish trước, KHÔNG phải
 * lỗi truy vấn.
 */
export async function findHtmlPublishableTemplateId(): Promise<string | null> {
  const templates = await db
    .select({ id: mergeTemplates.id })
    .from(mergeTemplates)
    .where(eq(mergeTemplates.isActive, true))
    .orderBy(mergeTemplates.createdAt);

  for (const template of templates) {
    const published = await getPublishedTemplateVersion(template.id);
    if (published) return template.id;
  }
  return null;
}

type FieldCoverageInput = {
  placeholder: string;
  sourceField: string | null;
  sourcePath: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
};

export type PlaceholderCoverageReason = "UNMAPPED" | "REQUIRED_UNRESOLVABLE";
export interface PlaceholderCoverageIssue {
  placeholder: string;
  reason: PlaceholderCoverageReason;
}

/**
 * Kiểm tra placeholder coverage trước khi publish — phân biệt RÕ 2 trường hợp:
 *
 * - UNMAPPED: placeholder xuất hiện trong HTML nhưng CHƯA từng có row mapping
 *   (chưa quét/lưu) → luôn chặn publish, vì PDF sẽ hiện nguyên "<<...>>".
 * - REQUIRED_UNRESOLVABLE: đã có mapping, `isRequired=true`, nhưng không có
 *   sourceField/sourcePath/fallbackValue nào → chắc chắn luôn rỗng dù bị đánh
 *   dấu bắt buộc → đây là lỗi cấu hình, chặn publish.
 *
 * Placeholder có mapping với `isRequired=false` (mặc định khi quét) LUÔN được
 * phép publish dù chưa gắn nguồn dữ liệu — đây là "để trống có chủ đích"
 * (business requirement), KHÔNG phải lỗi. Không tự ý gán fallback/dữ liệu giả
 * cho các placeholder này.
 */
export function validatePlaceholderCoverage(
  htmlBody: string,
  fields: FieldCoverageInput[],
): PlaceholderCoverageIssue[] {
  const placeholders = scanPlaceholdersInVersionHtml(htmlBody);
  const fieldMap = new Map(fields.map((f) => [f.placeholder, f]));
  const issues: PlaceholderCoverageIssue[] = [];

  for (const placeholder of placeholders) {
    const field = fieldMap.get(placeholder);
    if (!field) {
      issues.push({ placeholder, reason: "UNMAPPED" });
      continue;
    }
    if (field.isRequired && !field.sourceField && !field.sourcePath && !field.fallbackValue) {
      issues.push({ placeholder, reason: "REQUIRED_UNRESOLVABLE" });
    }
  }
  return issues;
}

function formatCoverageError(issues: PlaceholderCoverageIssue[]): string {
  const unmapped = issues.filter((i) => i.reason === "UNMAPPED").map((i) => i.placeholder);
  const unresolvable = issues.filter((i) => i.reason === "REQUIRED_UNRESOLVABLE").map((i) => i.placeholder);
  const parts: string[] = [];
  if (unmapped.length > 0) {
    parts.push(`${unmapped.length} placeholder chưa được quét/mapping: ${unmapped.join(", ")}`);
  }
  if (unresolvable.length > 0) {
    parts.push(
      `${unresolvable.length} placeholder bắt buộc (required) nhưng chưa có nguồn dữ liệu/fallback: ${unresolvable.join(", ")}`,
    );
  }
  return (
    `Không thể publish — ${parts.join("; ")}. ` +
    `Placeholder không bắt buộc (isRequired=false) luôn được phép để trống — nếu placeholder này để trống có chủ đích, ` +
    `KHÔNG bật "bắt buộc" cho nó trong Mapping.`
  );
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

    const coverageIssues = validatePlaceholderCoverage(target.htmlBody, fields);
    if (coverageIssues.length > 0) {
      throw new TemplateVersionError(formatCoverageError(coverageIssues), 400);
    }

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
