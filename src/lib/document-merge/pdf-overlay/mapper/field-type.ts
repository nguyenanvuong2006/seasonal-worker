/**
 * PDF Overlay — Visual Mapper field-type inference (PR3).
 *
 * Placeholder panel hiển thị "type" cho mỗi placeholder. Field mapping
 * (merge_template_fields) không lưu sẵn loại render PDF — suy ra từ formatType
 * (formatter hiện có của GOOGLE_DOCS) để đề xuất type ban đầu khi tạo position.
 * KHÔNG rewrite mapping GOOGLE_DOCS — chỉ là giá trị mặc định cho UI.
 */

import type { PdfPositionType } from "./../types.ts";

export function inferPositionType(
  formatType?: string | null,
  sourceType?: string | null,
): PdfPositionType {
  if (sourceType === "STATIC_TEXT") return "STATIC_TEXT";
  const f = (formatType ?? "").toUpperCase();
  if (f.startsWith("DATE")) return "DATE";
  if (f === "NUMBER" || f === "CURRENCY_VND" || f === "VIETNAMESE_NUMBER_WORDS") return "NUMBER";
  if (f === "BOOLEAN_CHECKBOX") return "CHECKBOX";
  return "TEXT";
}

/** Source key hiển thị trong panel: ưu tiên sourceField → sourcePath → sourceEntity. */
export function fieldSourceKey(field: { sourceField?: string | null; sourcePath?: string | null; sourceEntity?: string | null }): string {
  if (field.sourceField) return field.sourceField;
  if (field.sourcePath) return field.sourcePath;
  if (field.sourceEntity) return field.sourceEntity;
  return "";
}
