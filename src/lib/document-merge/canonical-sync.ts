/**
 * CANONICAL TEMPLATE MIGRATION — "Đồng bộ Google Doc → phiên bản HTML mới".
 *
 * This is the ONLY supported way to move the currently approved authoring
 * document into a canonical HTML version. It is an explicit ADMIN action.
 *
 * Guarantees:
 *   1. reads the selected Google Doc (Drive export, text/html — structure and
 *      inline styles preserved; text/plain export is NOT accepted because it
 *      cannot preserve the approved document)
 *   2. produces canonical HTML (body fragment + print CSS)
 *   3. preserves supported structure/styles/placeholders
 *   4. creates a NEW merge_template_versions DRAFT version
 *   5. NEVER publishes automatically
 *   6. the draft is previewable/verifiable before publish
 *   7. publish stays a separate, explicit admin action
 *   8. previous versions are never overwritten or deleted
 *
 * If conversion cannot faithfully preserve the approved document, this module
 * STOPS with CanonicalSyncError and reports the limitation. It never publishes
 * an approximation and never silently degrades to plain text.
 */

import { extractUniquePlaceholders } from "./placeholder-extractor.ts";

export class CanonicalSyncError extends Error {
  readonly code: string;
  readonly operatorMessage: string;
  readonly limitations: string[];
  readonly status: number;

  constructor(code: string, operatorMessage: string, limitations: string[] = [], status = 422) {
    super(`${code}: ${operatorMessage}`);
    this.name = "CanonicalSyncError";
    this.code = code;
    this.operatorMessage = operatorMessage;
    this.limitations = limitations;
    this.status = status;
  }
}

export interface CanonicalSyncResult {
  /** Body fragment only — no <html>/<head> wrapper, no candidate values. */
  htmlBody: string;
  /** Print CSS lifted from the exported document's <style> blocks. */
  printCss: string;
  placeholders: string[];
  /** Logical `.page`/page-break sections detected — informational, never enforced. */
  logicalPageCount: number;
  /** Non-blocking fidelity notes an operator must review before publishing. */
  warnings: string[];
  sourceDocId: string;
  sourceBytes: number;
}

/** Structural markers that prove the export is a real structured document. */
const STRUCTURE_MARKERS = [/<p\b/i, /<div\b/i, /<table\b/i, /<span\b/i, /<h[1-6]\b/i, /<li\b/i];

function extractStyles(html: string): string {
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1].trim());
  return blocks.filter(Boolean).join("\n\n");
}

function extractBody(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  return (match ? match[1] : html).trim();
}

/**
 * Remove non-document chrome. Scripts and embedded browsing contexts are
 * stripped as defence in depth; the shared renderer strips preview-only
 * authoring markup again at render time.
 */
function stripNonDocumentMarkup(bodyHtml: string): string {
  return bodyHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<(?:iframe|object|embed|noscript)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed|noscript)\s*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .trim();
}

/**
 * Count logical page sections without ever enforcing a number. Google Docs
 * HTML export marks explicit page breaks with `page-break-before`; a canonical
 * hand-authored source uses `.page` containers.
 */
export function countLogicalSections(bodyHtml: string): number {
  const pageContainers = (
    bodyHtml.match(/<[a-z][\w:-]*\b[^>]*\bclass\s*=\s*(?:"[^"]*\bpage\b[^"]*"|'[^']*\bpage\b[^']*')/gi) ?? []
  ).length;
  if (pageContainers > 0) return pageContainers;
  const explicitBreaks = (bodyHtml.match(/page-break-before\s*:\s*always/gi) ?? []).length;
  return explicitBreaks > 0 ? explicitBreaks + 1 : 1;
}

export interface ConvertOptions {
  /** Placeholders the operator expects; a mismatch is reported, never silently accepted. */
  expectedPlaceholders?: readonly string[] | null;
}

/**
 * Convert an exported Google Doc HTML document into canonical HTML + print CSS.
 *
 * Throws CanonicalSyncError when the export cannot faithfully represent the
 * approved document — the caller must surface the limitation instead of
 * creating an approximate version.
 */
export function convertGoogleDocHtmlToCanonical(
  exportedHtml: string,
  sourceDocId: string,
  options: ConvertOptions = {},
): CanonicalSyncResult {
  const raw = (exportedHtml ?? "").trim();
  if (raw.length === 0) {
    throw new CanonicalSyncError(
      "GOOGLE_DOC_EXPORT_EMPTY",
      "Google Doc xuất ra nội dung rỗng — không thể tạo phiên bản HTML canonical.",
      ["Bản xuất từ Google Drive không có nội dung."],
    );
  }

  // A text/plain export cannot preserve the approved document. Refuse it
  // rather than publishing an approximation (Phase 6 stop condition).
  if (!STRUCTURE_MARKERS.some((marker) => marker.test(raw))) {
    throw new CanonicalSyncError(
      "GOOGLE_DOC_EXPORT_NOT_STRUCTURED",
      "Bản xuất từ Google Doc không phải HTML có cấu trúc (không có thẻ đoạn/bảng/tiêu đề). " +
        "Chuyển đổi tự động KHÔNG thể giữ đúng tài liệu đã được duyệt, nên hệ thống dừng lại " +
        "thay vì tạo một bản gần đúng.",
      [
        "Drive export phải dùng mimeType=text/html (không dùng text/plain).",
        "Bố cục, bảng biểu, ô đánh dấu và kiểu chữ sẽ mất hoàn toàn nếu dùng text/plain.",
      ],
    );
  }

  const printCss = extractStyles(raw);
  const htmlBody = stripNonDocumentMarkup(extractBody(raw));

  if (htmlBody.length === 0) {
    throw new CanonicalSyncError(
      "GOOGLE_DOC_BODY_EMPTY",
      "Không tách được phần thân tài liệu từ bản xuất Google Doc.",
      ["Bản xuất không có <body> hợp lệ hoặc chỉ chứa script/style."],
    );
  }

  const placeholders = extractUniquePlaceholders(htmlBody);
  const warnings: string[] = [];

  if (placeholders.length === 0) {
    warnings.push(
      "Không tìm thấy placeholder nào ({{...}} hoặc <<...>>) trong tài liệu — bản nháp sẽ là tài liệu tĩnh.",
    );
  }
  if (printCss.length === 0) {
    warnings.push("Bản xuất không kèm CSS in — hãy kiểm tra Preview kỹ về bố cục trước khi Xuất bản.");
  }
  if (/<img\b[^>]*src\s*=\s*(?:"|')?https?:/i.test(htmlBody)) {
    warnings.push(
      "Tài liệu tham chiếu ảnh qua URL bên ngoài; trình render PDF chặn mạng nên ảnh này sẽ không hiển thị.",
    );
  }

  const expected = options.expectedPlaceholders ?? null;
  if (expected && expected.length > 0) {
    const actual = new Set(placeholders);
    const missing = [...new Set(expected)].filter((key) => !actual.has(key)).sort();
    const extra = placeholders.filter((key) => !expected.includes(key)).sort();
    if (missing.length > 0) {
      warnings.push(`Thiếu placeholder so với danh mục hiện có: ${missing.join(", ")}.`);
    }
    if (extra.length > 0) {
      warnings.push(`Có placeholder mới chưa nằm trong danh mục: ${extra.join(", ")}.`);
    }
  }

  return {
    htmlBody,
    printCss,
    placeholders,
    logicalPageCount: countLogicalSections(htmlBody),
    warnings,
    sourceDocId,
    sourceBytes: raw.length,
  };
}

/** Human label for the sync action, shown in the admin UI. */
export const CANONICAL_SYNC_ACTION_LABEL = "Đồng bộ Google Doc → phiên bản HTML mới";

/** Recorded on the created draft so its provenance is auditable. */
export function canonicalSyncSourceName(docId: string, at: Date): string {
  return `google-doc:${docId} (đồng bộ ${at.toISOString()}; DRAFT — chưa xuất bản)`;
}
