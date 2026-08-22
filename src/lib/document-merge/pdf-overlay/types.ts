/**
 * PDF Overlay Engine — domain types (PR1).
 *
 * KHÔNG import DB/schema/drizzle ở đây — module thuần để renderer + tests
 * (node --test) + worker dùng chung mà không cần kết nối Postgres.
 *
 * DB rows (pdf_field_positions / pdf_template_versions) được chuyển sang các
 * spec dưới đây qua `positions.ts::toPositionSpec`.
 */

export type PdfPositionType =
  | "TEXT"
  | "MULTILINE_TEXT"
  | "DATE"
  | "NUMBER"
  | "CHECKBOX"
  | "RADIO_OPTION"
  | "SIGNATURE_TEXT"
  | "STATIC_TEXT"
  | "IMAGE";

export const TEXT_POSITION_TYPES: readonly PdfPositionType[] = [
  "TEXT",
  "MULTILINE_TEXT",
  "DATE",
  "NUMBER",
  "SIGNATURE_TEXT",
];

export const CHECKBOX_POSITION_TYPES: readonly PdfPositionType[] = ["CHECKBOX", "RADIO_OPTION"];

export type Align = "left" | "center" | "right";
export type Valign = "top" | "middle" | "bottom";
export type CheckboxStyle = "SQUARE_X" | "SQUARE_TICK" | "SQUARE_FILLED" | "CIRCLE_DOT";
export type OverflowPolicy = "FAIL" | "ELLIPSIZE";

/** Bounding box (PDF points, gốc bottom-left). */
export interface PdfBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Một vị trí render của một placeholder. Cùng placeholder → nhiều spec. */
export interface PdfPositionSpec extends PdfBox {
  placeholder: string;
  pageNumber: number; // 1-based
  type: PdfPositionType;
  fontSize?: number;
  minFontSize?: number;
  fontFamily?: string | null;
  align?: Align;
  valign?: Valign;
  multiline?: boolean;
  maxLines?: number | null;
  rotation?: number;
  isRequired?: boolean;
  whiteout?: boolean;
  checkboxStyle?: CheckboxStyle;
  optionValue?: string | null;
  sourceKey?: string | null;
  overflowPolicy?: OverflowPolicy;
  staticText?: string | null;
}

/** Hình học 1 trang PDF đã chuẩn hoá (đơn vị pt). */
export interface PageGeometry {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
}

export interface PdfOverlayRenderOptions {
  /** Bắt buộc — PDF overlay KHÔNG dùng Standard-14 font (không hỗ trợ tiếng Việt). */
  fontBytes: Uint8Array;
  /** Nếu set, renderer sẽ fail khi số trang thật khác số này (STRUCTURAL gate). */
  expectedPageCount?: number;
  /** Subset font khi embed (mặc định true — PDF nhỏ hơn). */
  subsetFont?: boolean;
}

export interface PdfOverlayRenderResult {
  bytes: Uint8Array;
  sha256: string;
  pageCount: number;
  pages: PageGeometry[];
  positionsDrawn: number;
  warnings: string[];
}

export type PdfOverlayErrorCode =
  | "FONT_BYTES_REQUIRED"
  | "FONT_GLYPH_MISSING"
  | "TEMPLATE_PAGE_COUNT_MISMATCH"
  | "INVALID_PAGE_NUMBER"
  | "POSITION_OUT_OF_BOUNDS"
  | "MISSING_REQUIRED_FIELD"
  | "FIELD_OVERFLOW"
  | "UNSUPPORTED_FIELD_TYPE"
  | "ACROFORM_NOT_FOUND"
  | "ACROFORM_FIELD_NOT_FOUND";

export interface PdfOverlayErrorDetail {
  placeholder?: string;
  pageNumber?: number;
}

/** Lỗi render xác định (deterministic) — code ổn định để retry/triage. */
export class PdfOverlayError extends Error {
  readonly code: PdfOverlayErrorCode;
  readonly detail: PdfOverlayErrorDetail;

  constructor(code: PdfOverlayErrorCode, message: string, detail: PdfOverlayErrorDetail = {}) {
    super(message);
    this.name = "PdfOverlayError";
    this.code = code;
    this.detail = detail;
  }
}
