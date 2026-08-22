/**
 * PDF Overlay Mapper — client types + option lists (PR3).
 * Chỉ dùng ở client (không import server-only / DB).
 */

/** Một version PDF template (trả từ /pdf-versions). */
export interface PdfVersion {
  id: string;
  templateId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  pdfStorageKey: string;
  sha256: string;
  pageCount: number;
  pageLayout: { pageNumber: number; width: number; height: number; rotation: number }[];
  sourceNote: string | null;
  createdBy: string;
  publishedAt: string | null;
  archivedAt: string | null;
  supersededBy: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Một field position (trả từ /positions). */
export interface PdfPosition {
  id: string;
  pdfTemplateVersionId: string;
  placeholder: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
  fontSize: number;
  minFontSize: number | null;
  fontFamily: string | null;
  align: string;
  valign: string;
  multiline: boolean;
  maxLines: number | null;
  rotation: number;
  renderOrder: number;
  isRequired: boolean;
  whiteout: boolean;
  checkboxStyle: string | null;
  optionValue: string | null;
  sourceKey: string | null;
  overflowPolicy: string;
  staticText: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Payload khi tạo/update 1 position (khớp NewPdfFieldPositionInput của PR2). */
export interface PositionInput {
  placeholder: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
  fontSize?: number;
  minFontSize?: number | null;
  fontFamily?: string | null;
  align?: string;
  valign?: string;
  multiline?: boolean;
  maxLines?: number | null;
  rotation?: number;
  renderOrder?: number;
  isRequired?: boolean;
  whiteout?: boolean;
  checkboxStyle?: string | null;
  optionValue?: string | null;
  sourceKey?: string | null;
  overflowPolicy?: string;
  staticText?: string | null;
}

/** Kết quả verify integrity (trả từ /verify). */
export interface IntegrityResult {
  ok: boolean;
  sha256: string;
  expectedSha256: string;
  pageCount?: number;
  expectedPageCount?: number;
  pageLayout?: { pageNumber: number; width: number; height: number; rotation: number }[];
}

/** Danh sách loại field (đồng bộ validation.ts / schema). */
export const POSITION_TYPES = [
  "TEXT",
  "MULTILINE_TEXT",
  "DATE",
  "NUMBER",
  "CHECKBOX",
  "RADIO_OPTION",
  "SIGNATURE_TEXT",
  "STATIC_TEXT",
  "IMAGE",
] as const;

export const ALIGN_OPTIONS = ["left", "center", "right"] as const;
export const VALIGN_OPTIONS = ["top", "middle", "bottom"] as const;
export const CHECKBOX_STYLE_OPTIONS = ["SQUARE_X", "SQUARE_TICK", "SQUARE_FILLED", "CIRCLE_DOT"] as const;
export const OVERFLOW_POLICY_OPTIONS = ["FAIL", "ELLIPSIZE"] as const;

/** Status labels cho UI. */
export const VERSION_STATUS_LABEL: Record<PdfVersion["status"], string> = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  ARCHIVED: "ARCHIVED",
};

export function isVersionEditable(status: PdfVersion["status"]): boolean {
  return status === "DRAFT";
}

export function formatPt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100) / 100}`;
}
