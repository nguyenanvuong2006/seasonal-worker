/**
 * PDF Overlay Engine — coordinate system contract (PR1).
 *
 * HỆ TỌA ĐỘ NỘI BỘ DUY NHẤT: PDF user-space points, gốc BOTTOM-LEFT.
 *   - x/y của PdfBox = góc dưới-trái của bounding box, đơn vị pt (1pt = 1/72 inch).
 *   - KHÔNG có giả định DPI (pt độc lập với độ phân giải); DPI chỉ dùng ở raster
 *     preview (visual mapper sau này), luôn chuyển về pt trước khi lưu.
 *   - Visual mapper (browser) và renderer (pdf-lib) PHẢI dùng cùng contract này.
 *
 * A4 portrait = 595.28 × 841.89 pt. mm↔pt: pt = mm × 72 / 25.4.
 */

export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;
export const MM_TO_PT = 72 / 25.4; // 1 mm = 2.83464567 pt
export const VALID_ROTATIONS = [0, 90, 180, 270] as const;

/** Sai số float cho kiểm tra biên (tránh false-positive do 595.2800000001). */
export const BOUNDS_EPSILON = 0.01;

export function mmToPt(mm: number): number {
  return mm * MM_TO_PT;
}

export function ptToMm(pt: number): number {
  return pt / MM_TO_PT;
}

export function isValidRotation(rotation: number): boolean {
  return (VALID_ROTATIONS as readonly number[]).includes(rotation);
}

/** Trả true khi box nằm TRỌN trong trang (kể cả biên, dung sai epsilon). */
export function isBoxInsidePage(
  box: { x: number; y: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number,
): boolean {
  if (box.width <= 0 || box.height <= 0) return false;
  if (box.x < -BOUNDS_EPSILON || box.y < -BOUNDS_EPSILON) return false;
  if (box.x + box.width > pageWidth + BOUNDS_EPSILON) return false;
  if (box.y + box.height > pageHeight + BOUNDS_EPSILON) return false;
  return true;
}

/**
 * Chuẩn hoá mediaBox + rotation về {width, height} đã "hiển thị" (đơn vị pt).
 * pdf-lib `page.getSize()` đã trả kích thước SAU rotation; hàm này tồn tại để
 * contract rõ ràng khi sau này cần đọc trực tiếp mediaBox/cropBox.
 */
export function normalizePageGeometry(
  mediaBox: { x: number; y: number; width: number; height: number },
  rotation: number,
): { width: number; height: number } {
  const { width, height } = mediaBox;
  const r = ((rotation % 360) + 360) % 360;
  if (!isValidRotation(r)) {
    throw new Error(`GEOMETRY_INVALID_ROTATION: ${rotation}`);
  }
  return r === 90 || r === 270 ? { width: height, height: width } : { width, height };
}
