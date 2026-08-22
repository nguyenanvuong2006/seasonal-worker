/**
 * PDF Overlay Engine — field-position validation (PR2, management layer).
 *
 * Hàm THUẦN (không DB/storage): nhận input vị trí + page_layout của version,
 * trả danh sách lỗi (rỗng = đạt). Dùng cho:
 *   - create/update/bulk-upsert position (chặn trước khi ghi DB);
 *   - gate trước publish (structural — renderer cũng tự validate lại fail-fast).
 *
 * Quy tắc được chuẩn hoá từ schema + design (docs/PDF-COORDINATE-MAPPING-ENGINE-DESIGN.md):
 *   geometry, page number, type, font size, alignment, overflow, checkbox, required/static.
 */

import { isBoxInsidePage, isValidRotation } from "./geometry.ts";
import type {
  Align,
  CheckboxStyle,
  OverflowPolicy,
  PageGeometry,
  PdfPositionType,
  Valign,
} from "./types.ts";

export const VALID_POSITION_TYPES: readonly PdfPositionType[] = [
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

export const VALID_ALIGN: readonly Align[] = ["left", "center", "right"];
export const VALID_VALIGN: readonly Valign[] = ["top", "middle", "bottom"];
export const VALID_CHECKBOX_STYLES: readonly CheckboxStyle[] = [
  "SQUARE_X",
  "SQUARE_TICK",
  "SQUARE_FILLED",
  "CIRCLE_DOT",
];
export const VALID_OVERFLOW_POLICIES: readonly OverflowPolicy[] = ["FAIL", "ELLIPSIZE"];

/** Input vị trí chuẩn hoá cho validate + insert (defaults do service áp). */
export interface PositionValidationInput {
  placeholder: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type?: PdfPositionType;
  fontSize?: number;
  minFontSize?: number | null;
  align?: Align;
  valign?: Valign;
  maxLines?: number | null;
  rotation?: number;
  isRequired?: boolean;
  checkboxStyle?: CheckboxStyle | null;
  optionValue?: string | null;
  sourceKey?: string | null;
  overflowPolicy?: OverflowPolicy;
  staticText?: string | null;
}

/** Khoá tự nhiên của 1 position (đồng bộ với UNIQUE index trong DB). */
export interface PositionKey {
  placeholder: string;
  pageNumber: number;
  x: number;
  y: number;
}

export function positionKeyOf(p: PositionKey): string {
  return `${p.placeholder}\u0000${p.pageNumber}\u0000${p.x}\u0000${p.y}`;
}

/** Tìm khoá trùng trong 1 tập (dùng cho bulk upsert + duplicate check). */
export function findDuplicateKeys(positions: PositionKey[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const p of positions) {
    const k = positionKeyOf(p);
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
}

/** Lấy geometry của 1 trang theo page_number (1-based); undefined nếu không tồn tại. */
function pageGeometryFor(pages: PageGeometry[], pageNumber: number): PageGeometry | undefined {
  return pages.find((p) => p.pageNumber === pageNumber);
}

/**
 * Validate input vị trí đối chiếu page_layout của version. Trả danh sách lỗi.
 */
export function validatePositionInput(
  input: PositionValidationInput,
  pages: PageGeometry[],
): string[] {
  const errors: string[] = [];

  const placeholder = (input.placeholder ?? "").trim();
  if (!placeholder) {
    errors.push("placeholder là bắt buộc.");
  } else if (placeholder.length > 255) {
    errors.push("placeholder vượt quá 255 ký tự.");
  }

  // page number
  if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1) {
    errors.push(`page_number phải là số nguyên ≥ 1 (nhận: ${input.pageNumber}).`);
  } else if (!pageGeometryFor(pages, input.pageNumber)) {
    errors.push(`page_number=${input.pageNumber} không tồn tại trong template (${pages.length} trang).`);
  }

  // geometry
  const page = pageGeometryFor(pages, input.pageNumber);
  if (page && (!Number.isFinite(input.x) || !Number.isFinite(input.y) || !Number.isFinite(input.width) || !Number.isFinite(input.height))) {
    errors.push("x/y/width/height phải là số hợp lệ.");
  } else if (page && !isBoxInsidePage({ x: input.x, y: input.y, width: input.width, height: input.height }, page.width, page.height)) {
    errors.push(
      `box (${input.x},${input.y},${input.width},${input.height}) nằm ngoài trang ${input.pageNumber} (${page.width}×${page.height}).`,
    );
  }

  // type
  const type = input.type ?? "TEXT";
  if (!VALID_POSITION_TYPES.includes(type)) {
    errors.push(`type=${type} không hợp lệ.`);
  }

  // rotation
  if (input.rotation !== undefined && !isValidRotation(input.rotation)) {
    errors.push(`rotation=${input.rotation} không hợp lệ (0/90/180/270).`);
  }

  // font size
  if (input.fontSize !== undefined && (!Number.isFinite(input.fontSize) || input.fontSize <= 0)) {
    errors.push(`fontSize=${input.fontSize} phải > 0.`);
  }
  if (input.minFontSize !== undefined && input.minFontSize !== null) {
    if (!Number.isFinite(input.minFontSize) || input.minFontSize <= 0) {
      errors.push(`minFontSize=${input.minFontSize} phải > 0.`);
    } else if (input.fontSize !== undefined && input.minFontSize > input.fontSize) {
      errors.push(`minFontSize (${input.minFontSize}) > fontSize (${input.fontSize}).`);
    }
  }
  if (input.maxLines !== undefined && input.maxLines !== null && input.maxLines < 1) {
    errors.push(`maxLines=${input.maxLines} phải ≥ 1.`);
  }

  // alignment / overflow
  if (input.align !== undefined && !VALID_ALIGN.includes(input.align)) {
    errors.push(`align=${input.align} không hợp lệ (left/center/right).`);
  }
  if (input.valign !== undefined && !VALID_VALIGN.includes(input.valign)) {
    errors.push(`valign=${input.valign} không hợp lệ (top/middle/bottom).`);
  }
  if (input.overflowPolicy !== undefined && !VALID_OVERFLOW_POLICIES.includes(input.overflowPolicy)) {
    errors.push(`overflowPolicy=${input.overflowPolicy} không hợp lệ (FAIL/ELLIPSIZE).`);
  }
  if (input.checkboxStyle !== undefined && input.checkboxStyle !== null && !VALID_CHECKBOX_STYLES.includes(input.checkboxStyle)) {
    errors.push(`checkboxStyle=${input.checkboxStyle} không hợp lệ.`);
  }

  // checkbox / radio rules
  const isCheckbox = type === "CHECKBOX" || type === "RADIO_OPTION";
  if (isCheckbox) {
    if (!input.optionValue || input.optionValue.trim() === "") {
      errors.push(`${type} yêu cầu optionValue (option mà box này đánh dấu).`);
    }
    if (!input.sourceKey || input.sourceKey.trim() === "") {
      errors.push(`${type} yêu cầu sourceKey (nguồn quyết định trạng thái).`);
    }
  }

  // required / source / static-text rules
  if (type === "STATIC_TEXT") {
    if (!input.staticText || input.staticText.trim() === "") {
      errors.push("STATIC_TEXT yêu cầu staticText (nội dung tĩnh).");
    }
    if (input.isRequired) {
      errors.push("STATIC_TEXT không thể là required (không có nguồn dữ liệu).");
    }
  } else if (input.staticText) {
    errors.push(`staticText chỉ dùng cho STATIC_TEXT (type=${type}).`);
  }

  return errors;
}
