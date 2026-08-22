/**
 * PDF Overlay — Visual Mapper checkbox state helper (PR3, pure).
 * Chuyển value đã resolve (checkbox-engine → "☒"/"☐", hoặc "X"/""/truthy) thành
 * boolean quyết định vẽ mark. Không render glyph. Đồng bộ tinh thần với PR1
 * renderer::checkboxStateFromValue nhưng module THUẦN (chạy browser + node).
 */

export function checkboxStateFromValue(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  if (v === "") return false;
  if (v === "☐" || v === "0" || v === "false" || v === "FALSE" || v === "no" || v === "NO") return false;
  return true;
}

/** Đánh giá trạng thái 1 checkbox position dựa trên optionValue + sample value. */
export function isSampleCheckboxChecked(
  sampleValue: string | undefined,
  optionValue: string | null | undefined,
): boolean {
  const v = (sampleValue ?? "").trim();
  if (v === "") return false;
  if (optionValue && v !== optionValue && !v.includes(optionValue)) return false;
  return checkboxStateFromValue(v);
}
