/**
 * Document Merge — Engine feature flag.
 *
 * DOCUMENT_MERGE_ENGINE:
 *   - GOOGLE_DOCS  (default) → legacy engine: copy Google Doc + replace placeholders.
 *                              Đây là fallback an toàn trong giai đoạn migration.
 *   - HTML_PDF               → new engine: HTML/CSS print template → Playwright PDF
 *                              trên Cloud Run, chạy bất đồng bộ qua queue.
 *
 * Admin có thể rollback bằng ENV mà KHÔNG cần revert code.
 *
 * Module này THUẦN (không import server-only) để dùng được cả trong Next.js
 * API routes lẫn Cloud Run worker.
 */

export type DocumentMergeEngine = "GOOGLE_DOCS" | "HTML_PDF";

export const DOCUMENT_MERGE_ENGINES = ["GOOGLE_DOCS", "HTML_PDF"] as const;

export function parseDocumentMergeEngine(value: string | null | undefined): DocumentMergeEngine {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "HTML_PDF" ? "HTML_PDF" : "GOOGLE_DOCS";
}

/** Engine đang được bật cho batch merge. Default = GOOGLE_DOCS (legacy). */
export function getDocumentMergeEngine(): DocumentMergeEngine {
  return parseDocumentMergeEngine(process.env.DOCUMENT_MERGE_ENGINE);
}

export function isHtmlPdfEngine(): boolean {
  return getDocumentMergeEngine() === "HTML_PDF";
}
