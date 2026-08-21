/**
 * Document Merge — GOOGLE_DOCS template/field audit (READ-ONLY logic).
 *
 * QUAN TRỌNG: merge_template_versions (DRAFT/PUBLISHED) — publishedVersionCount
 * mà production-readiness báo cáo — CHỈ liên quan tới engine HTML_PDF
 * (async-job.ts snapshot htmlBody/printCss từ đó). Route
 * POST /api/document-merge/merge/execute (engine GOOGLE_DOCS, cái đang xét ở
 * đây) KHÔNG BAO GIỜ đọc bảng đó — nó đọc TRỰC TIẾP nội dung Google Doc sống
 * qua merge_templates.google_doc_id (xem google-docs-service.ts
 * getDocumentContent). Vì vậy publish version HTML KHÔNG có tác dụng gì tới
 * khả năng chạy GOOGLE_DOCS — module này audit đúng thứ GOOGLE_DOCS thực sự
 * cần: merge_templates.is_active/output_folder_id + merge_template_fields
 * khớp với placeholder thật trong Google Doc.
 *
 * Thuần logic (không I/O) để test được không cần DB/Google API thật — route
 * gọi module này SAU KHI đã tự đọc DB + gọi getDocumentContent() (read-only,
 * KHÔNG ghi gì — khác hẳn POST .../scan vốn ghi isOrphaned + insert field mới).
 */

export interface TemplateFieldRow {
  placeholder: string;
  isRequired: boolean;
  isOrphaned: boolean;
  fallbackValue: string | null;
}

export interface TemplateFieldAuditResult {
  /** Placeholder có trong Google Doc sống nhưng KHÔNG có field mapping — sẽ còn lại literal <<...>> trong output. */
  danglingInDoc: string[];
  /** Field có mapping trong DB nhưng placeholder không còn xuất hiện trong Google Doc — mapping cũ/thừa. */
  staleInFields: string[];
  /** Field required=true nhưng không có fallbackValue — record thiếu dữ liệu nguồn sẽ bị preflight từ chối (không phải lỗi, nhưng cần biết trước). */
  requiredWithoutFallback: string[];
  /** field.isOrphaned=true trong DB nhưng placeholder ĐÃ quay lại xuất hiện trong doc — dữ liệu isOrphaned có thể đang lỗi thời (doc đã sửa lại sau khi đánh dấu orphaned, chưa scan lại). */
  markedOrphanedButPresentInDoc: string[];
  /** true nếu không có vấn đề nào ở trên — an toàn để chạy preflight thật. */
  clean: boolean;
}

export function auditTemplateFields(
  liveDocPlaceholders: string[],
  fields: TemplateFieldRow[],
): TemplateFieldAuditResult {
  const docSet = new Set(liveDocPlaceholders);
  const fieldSet = new Set(fields.map((f) => f.placeholder));

  const danglingInDoc = liveDocPlaceholders.filter((p) => !fieldSet.has(p)).sort();
  const staleInFields = fields
    .filter((f) => !f.isOrphaned && !docSet.has(f.placeholder))
    .map((f) => f.placeholder)
    .sort();
  const requiredWithoutFallback = fields
    .filter((f) => f.isRequired && !f.fallbackValue?.trim())
    .map((f) => f.placeholder)
    .sort();
  const markedOrphanedButPresentInDoc = fields
    .filter((f) => f.isOrphaned && docSet.has(f.placeholder))
    .map((f) => f.placeholder)
    .sort();

  return {
    danglingInDoc,
    staleInFields,
    requiredWithoutFallback,
    markedOrphanedButPresentInDoc,
    clean: danglingInDoc.length === 0 && staleInFields.length === 0 && markedOrphanedButPresentInDoc.length === 0,
  };
}
