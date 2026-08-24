/**
 * PREVIEW RESPONSE NORMALIZER — incident fix (canonical preview crash).
 *
 * ROOT CAUSE của sự cố /admin/document-merge "This page couldn't load":
 * nhánh CANONICAL_PUBLISHED_PREVIEW (PR #91) trả `unresolved` thay vì
 * `unreplaced`, trong khi merge-workspace render `preview.unreplaced.length`
 * → TypeError trong React render → không có error boundary → toàn bộ route
 * bị unmount.
 *
 * Nguyên tắc từ nay: KHÔNG BAO GIỜ đưa payload API thô vào React state của
 * Preview. Mọi response đi qua normalizer thuần này — mọi field mà UI
 * dereference đều được đảm bảo đúng kiểu (mảng luôn là mảng, chuỗi luôn là
 * chuỗi), bất kể server trả thiếu key, sai kiểu hay malformed JSON object.
 *
 * Module này THUẦN (không import React/next/db) để test được bằng node --test
 * theo đúng khuôn mẫu repo.
 */

export interface SafePreviewResult {
  applicationId: string;
  fullName: string;
  cccd: string;
  deptName: string | null;
  startingDate: string | null;
  dwClassification: "OLD" | "NEW";
  documentKind: "A" | "B";
  documentKindLabel: string;
  templateId?: string;
  templateName: string;
  content: string;
  /** LUÔN là mảng — không bao giờ undefined. */
  missingFields: string[];
  /** LUÔN là mảng — hợp nhất `unreplaced` (legacy) + `unresolved` (canonical). */
  unreplaced: string[];
  valid: boolean;
  mappingSummary?: { total: number; mapped: number; required: number; suggested: number };
  mode?: string;
  renderedHtml?: string;
  templateVersion: number | null;
  versionStatus: string | null;
  isPublishedCanonical: boolean;
  engine: string | null;
  pageCount: number | null;
  renderer: string | null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Chuẩn hoá MỌI payload Preview (legacy Google Docs / canonical published /
 * html version) về một shape an toàn tuyệt đối cho React render.
 *
 * Không ném lỗi với bất kỳ input nào (null, mảng, chuỗi, object thiếu key…).
 */
export function normalizePreviewResponse(raw: unknown): SafePreviewResult {
  const data: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  // Hợp nhất legacy `unreplaced` và canonical `unresolved` — cùng ngữ nghĩa
  // (placeholder chưa được thay thế), khác tên giữa hai nhánh API.
  const unreplaced = [...new Set([...asStringArray(data.unreplaced), ...asStringArray(data.unresolved)])];

  const mappingSummaryRaw =
    data.mappingSummary !== null && typeof data.mappingSummary === "object"
      ? (data.mappingSummary as Record<string, unknown>)
      : null;

  return {
    applicationId: asString(data.applicationId ?? data.recordId),
    fullName: asString(data.fullName),
    cccd: asString(data.cccd),
    deptName: asOptionalString(data.deptName),
    startingDate: asOptionalString(data.startingDate),
    dwClassification: data.dwClassification === "OLD" ? "OLD" : "NEW",
    documentKind: data.documentKind === "B" ? "B" : "A",
    documentKindLabel: asString(data.documentKindLabel),
    templateId: asOptionalString(data.templateId) ?? undefined,
    templateName: asString(data.templateName),
    content: asString(data.content),
    missingFields: asStringArray(data.missingFields),
    unreplaced,
    valid: data.valid === true,
    mappingSummary: mappingSummaryRaw
      ? {
          total: asPositiveInt(mappingSummaryRaw.total) ?? 0,
          mapped: asPositiveInt(mappingSummaryRaw.mapped) ?? 0,
          required: asPositiveInt(mappingSummaryRaw.required) ?? 0,
          suggested: asPositiveInt(mappingSummaryRaw.suggested) ?? 0,
        }
      : undefined,
    mode: asOptionalString(data.mode) ?? undefined,
    renderedHtml: asOptionalString(data.renderedHtml) ?? undefined,
    templateVersion: asPositiveInt(data.templateVersion ?? data.version),
    versionStatus: asOptionalString(data.versionStatus),
    isPublishedCanonical: data.isPublishedCanonical === true,
    engine: asOptionalString(data.engine),
    pageCount: asPositiveInt(data.pageCount),
    renderer: asOptionalString(data.renderer),
  };
}
