/**
 * PDF Overlay Engine — position mapping + structural validation (PR1).
 *
 * - Chuyển row DB (PdfFieldPosition) → PdfPositionSpec (renderer dùng).
 * - Sắp xếp theo (pageNumber, renderOrder) — thứ tự vẽ xác định.
 * - validatePositionSpecs: STRUCTURAL gate thuần (page bounds, rotation, size).
 *
 * Một placeholder có NHIỀU position (vd Ho_ten ở page 1/4/6) — tất cả đọc CÙNG
 * MỘT giá trị đã resolve từ fieldValues[placeholder]. Không có logic nghiệp vụ
 * nào ở đây — business resolution nằm ở data-resolver.ts (reuse).
 */

import { isBoxInsidePage, isValidRotation, BOUNDS_EPSILON } from "./geometry.ts";
import { PdfOverlayError, type PageGeometry, type PdfPositionSpec, type PdfPositionType } from "./types.ts";

const KNOWN_TYPES: readonly PdfPositionType[] = [
  "TEXT",
  "MULTILINE_TEXT",
  "DATE",
  "NUMBER",
  "CHECKBOX",
  "RADIO_OPTION",
  "SIGNATURE_TEXT",
  "STATIC_TEXT",
  "IMAGE",
];

export interface PositionDbRow {
  placeholder: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
  fontSize?: number | null;
  minFontSize?: number | null;
  fontFamily?: string | null;
  align?: string | null;
  valign?: string | null;
  multiline?: boolean | null;
  maxLines?: number | null;
  rotation?: number | null;
  isRequired?: boolean | null;
  whiteout?: boolean | null;
  checkboxStyle?: string | null;
  optionValue?: string | null;
  sourceKey?: string | null;
  overflowPolicy?: string | null;
  staticText?: string | null;
}

/** Chuyển 1 row DB → spec. Giá trị undefined được để renderer áp default. */
export function toPositionSpec(row: PositionDbRow): PdfPositionSpec {
  const align = (row.align ?? "left") as PdfPositionSpec["align"];
  const valign = (row.valign ?? "top") as PdfPositionSpec["valign"];
  const checkboxStyle = row.checkboxStyle
    ? (row.checkboxStyle as PdfPositionSpec["checkboxStyle"])
    : undefined;
  const overflowPolicy = (row.overflowPolicy ?? "FAIL") as PdfPositionSpec["overflowPolicy"];
  return {
    placeholder: row.placeholder,
    pageNumber: row.pageNumber,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    type: row.type as PdfPositionType,
    fontSize: row.fontSize ?? undefined,
    minFontSize: row.minFontSize ?? undefined,
    fontFamily: row.fontFamily ?? undefined,
    align,
    valign,
    multiline: row.multiline ?? undefined,
    maxLines: row.maxLines ?? undefined,
    rotation: row.rotation ?? undefined,
    isRequired: row.isRequired ?? undefined,
    whiteout: row.whiteout ?? undefined,
    checkboxStyle,
    optionValue: row.optionValue ?? undefined,
    sourceKey: row.sourceKey ?? undefined,
    overflowPolicy,
    staticText: row.staticText ?? undefined,
  };
}

export function sortPositions(positions: PdfPositionSpec[]): PdfPositionSpec[] {
  return [...positions].sort((a, b) => a.pageNumber - b.pageNumber || a.x - b.x || a.y - b.y);
}

/**
 * STRUCTURAL validation (thuần, không throw) — dùng cho gate trước publish.
 * Trả danh sách lỗi; rỗng = đạt. Renderer cũng tự validate lại (fail-fast).
 */
export function validatePositionSpecs(
  positions: PdfPositionSpec[],
  pages: PageGeometry[],
): PdfOverlayError[] {
  const errors: PdfOverlayError[] = [];
  const pageByNumber = new Map(pages.map((p) => [p.pageNumber, p]));

  for (const pos of positions) {
    const page = pageByNumber.get(pos.pageNumber);
    if (!page) {
      errors.push(new PdfOverlayError("INVALID_PAGE_NUMBER", `pageNumber=${pos.pageNumber} không tồn tại.`, { placeholder: pos.placeholder, pageNumber: pos.pageNumber }));
      continue;
    }
    if (!KNOWN_TYPES.includes(pos.type)) {
      errors.push(new PdfOverlayError("UNSUPPORTED_FIELD_TYPE", `type=${pos.type} không hợp lệ.`, { placeholder: pos.placeholder }));
    }
    if (pos.rotation !== undefined && !isValidRotation(pos.rotation)) {
      errors.push(new PdfOverlayError("POSITION_OUT_OF_BOUNDS", `rotation=${pos.rotation} không hợp lệ (0/90/180/270).`, { placeholder: pos.placeholder }));
    }
    if (pos.fontSize !== undefined && pos.minFontSize !== undefined && pos.minFontSize > pos.fontSize + BOUNDS_EPSILON) {
      errors.push(new PdfOverlayError("POSITION_OUT_OF_BOUNDS", `minFontSize (${pos.minFontSize}) > fontSize (${pos.fontSize}).`, { placeholder: pos.placeholder }));
    }
    if (pos.maxLines !== null && pos.maxLines !== undefined && pos.maxLines < 1) {
      errors.push(new PdfOverlayError("POSITION_OUT_OF_BOUNDS", `maxLines=${pos.maxLines} < 1.`, { placeholder: pos.placeholder }));
    }
    if (!isBoxInsidePage(pos, page.width, page.height)) {
      errors.push(new PdfOverlayError("POSITION_OUT_OF_BOUNDS", `box (${pos.x},${pos.y},${pos.width},${pos.height}) nằm ngoài trang ${pos.pageNumber} (${page.width}×${page.height}).`, { placeholder: pos.placeholder, pageNumber: pos.pageNumber }));
    }
  }
  return errors;
}
