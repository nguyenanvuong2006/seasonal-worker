/**
 * PDF Overlay Engine — core coordinate renderer (PR1).
 *
 * Hàm THUẦN + xác định (deterministic):
 *   renderPdfOverlay(templatePdf, positions, fieldValues, options) → bytes + sha256
 *
 * Contract dữ liệu (KHÔNG có logic nghiệp vụ ở đây):
 *   daily_application → buildApplicantMergeRecord → resolveAllFields
 *   → fieldValues: Record<placeholder, string> → renderer này.
 *
 * - Text: fit + shrink + align/valign + FIELD_OVERFLOW (deterministic).
 * - Checkbox/radio: vẽ vector (đường/rect) — KHÔNG phụ thuộc glyph trình duyệt.
 * - Một placeholder nhiều position → cùng fieldValues[placeholder], vẽ lặp lại.
 * - Template nền được clone bằng cách load bytes mới mỗi lần gọi (immutable).
 */

import crypto from "node:crypto";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { embedVietnameseFont, type FontkitFont } from "./vietnamese-font.ts";
import { isBoxInsidePage } from "./geometry.ts";
import { sortPositions } from "./positions.ts";
import {
  ellipsizeToWidth,
  fitText,
  layoutFittedText,
  type FittedText,
  type MeasureFont,
} from "./text-fitting.ts";
import {
  CHECKBOX_POSITION_TYPES,
  PdfOverlayError,
  TEXT_POSITION_TYPES,
  type CheckboxStyle,
  type PageGeometry,
  type PdfBox,
  type PdfOverlayRenderOptions,
  type PdfOverlayRenderResult,
  type PdfPositionSpec,
} from "./types.ts";

const DEFAULT_FONT_SIZE = 10;
const DEFAULT_ALIGN = "left";
const DEFAULT_VALIGN = "top";
const DEFAULT_CHECKBOX_STYLE: CheckboxStyle = "SQUARE_X";
const WHITEOUT_PADDING_PT = 1;

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Chuyển giá trị checkbox đã resolve (checkbox-engine → "☒"/"☐", hoặc "X"/"" từ
 * sample values) thành boolean. KHÔNG render glyph — chỉ là quyết định vẽ.
 */
export function checkboxStateFromValue(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  if (v === "") return false;
  if (v === "☐" || v === "0" || v === "false" || v === "FALSE" || v === "no" || v === "NO") return false;
  return true;
}

/** Adapter đo text: width từ PDFFont (subset, khớp thứ được vẽ) + metrics từ fontkit. */
function makeMeasure(pdfFont: PDFFont, fkFont: FontkitFont): MeasureFont {
  const u = fkFont.unitsPerEm || 1000;
  const ascent = fkFont.ascent ?? u * 0.8;
  const descent = fkFont.descent ?? -u * 0.2; // âm trong font units
  const lineGap = fkFont.lineGap ?? 0;
  return {
    widthOfText: (t, s) => pdfFont.widthOfTextAtSize(t, s),
    ascentAt: (s) => (s * ascent) / u,
    descentAt: (s) => (s * Math.abs(descent)) / u,
    lineHeightAt: (s) => (s * (ascent - descent + lineGap)) / u,
  };
}

/** Vẽ checkbox/radio bằng vector — deterministic, không glyph. */
function drawCheckbox(page: PDFPage, box: PdfBox, checked: boolean, style: CheckboxStyle): void {
  const size = Math.min(box.width, box.height);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const half = size / 2;
  const lw = Math.max(0.5, Math.round(size * 0.08 * 10) / 10);

  if (style === "CIRCLE_DOT") {
    page.drawEllipse({
      x: cx - half,
      y: cy - half,
      xScale: half,
      yScale: half,
      borderColor: BLACK,
      borderWidth: lw,
    });
    if (checked) {
      const dot = half * 0.45;
      page.drawEllipse({ x: cx - dot, y: cy - dot, xScale: dot, yScale: dot, color: BLACK });
    }
    return;
  }

  page.drawRectangle({
    x: cx - half,
    y: cy - half,
    width: size,
    height: size,
    borderColor: BLACK,
    borderWidth: lw,
  });
  if (!checked) return;

  const inset = half * 0.25;
  const l = cx - half + inset;
  const r = cx + half - inset;
  const b = cy - half + inset;
  const t = cy + half - inset;

  if (style === "SQUARE_X") {
    page.drawLine({ start: { x: l, y: b }, end: { x: r, y: t }, thickness: lw, color: BLACK });
    page.drawLine({ start: { x: r, y: b }, end: { x: l, y: t }, thickness: lw, color: BLACK });
  } else if (style === "SQUARE_TICK") {
    page.drawLine({ start: { x: l, y: cy - half * 0.1 }, end: { x: cx - half * 0.15, y: b + half * 0.35 }, thickness: lw, color: BLACK });
    page.drawLine({ start: { x: cx - half * 0.15, y: b + half * 0.35 }, end: { x: r, y: t }, thickness: lw, color: BLACK });
  } else {
    page.drawRectangle({ x: l, y: b, width: r - l, height: t - b, color: BLACK });
  }
}

/** Vẽ 1 text value đã fit — nếu vẫn tràn thì FAIL hoặc ELLIPSIZE (optional). */
function drawTextPosition(
  page: PDFPage,
  pos: PdfPositionSpec,
  value: string,
  font: PDFFont,
  measure: MeasureFont,
): void {
  const fontSize = pos.fontSize ?? DEFAULT_FONT_SIZE;
  const minFontSize = pos.minFontSize ?? fontSize;
  const align = pos.align ?? DEFAULT_ALIGN;
  const valign = pos.valign ?? DEFAULT_VALIGN;
  const multiline = pos.multiline ?? false;
  const maxLines = pos.maxLines ?? null;

  const fit = fitText({ text: value, box: pos, fontSize, minFontSize, align, valign, multiline, maxLines, measure });

  if (!fit.ok) {
    if (pos.overflowPolicy === "ELLIPSIZE" && !pos.isRequired) {
      const single = value.replace(/\s*\r?\n\s*/g, " ").trimEnd();
      const ell = ellipsizeToWidth(single, pos.width, minFontSize, measure);
      const synthetic: FittedText = {
        ok: true,
        fontSize: minFontSize,
        lines: [ell],
        lineHeight: measure.lineHeightAt(minFontSize),
        ascent: measure.ascentAt(minFontSize),
        descent: measure.descentAt(minFontSize),
      };
      const layout = layoutFittedText(synthetic, pos, align, valign, measure);
      for (const l of layout) {
        page.drawText(l.line, { x: l.x, y: l.baselineY, size: synthetic.fontSize, font, color: BLACK });
      }
      return;
    }
    throw new PdfOverlayError(
      "FIELD_OVERFLOW",
      `placeholder=${pos.placeholder} không vừa box ${pos.width}×${pos.height}pt ở minFontSize=${minFontSize}.`,
      { placeholder: pos.placeholder, pageNumber: pos.pageNumber },
    );
  }

  const layout = layoutFittedText(fit, pos, align, valign, measure);
  for (const l of layout) {
    page.drawText(l.line, { x: l.x, y: l.baselineY, size: fit.fontSize, font, color: BLACK });
  }
}

/**
 * Render overlay: clone template (load bytes) → vẽ từng position → save → sha256.
 * Throw PdfOverlayError (code ổn định) ở lỗi STRUCTURAL/fit — deterministic.
 */
export async function renderPdfOverlay(
  templatePdf: Uint8Array,
  positions: PdfPositionSpec[],
  fieldValues: Record<string, string>,
  options: PdfOverlayRenderOptions,
): Promise<PdfOverlayRenderResult> {
  if (!options.fontBytes || options.fontBytes.byteLength === 0) {
    throw new PdfOverlayError("FONT_BYTES_REQUIRED", "Cần fontBytes — PDF overlay không dùng Standard-14 font.");
  }

  const pdfDoc = await PDFDocument.load(templatePdf, { updateMetadata: false });
  const pageCount = pdfDoc.getPageCount();

  if (options.expectedPageCount !== undefined && options.expectedPageCount !== pageCount) {
    throw new PdfOverlayError(
      "TEMPLATE_PAGE_COUNT_MISMATCH",
      `Mong đợi ${options.expectedPageCount} trang, template có ${pageCount}.`,
    );
  }

  const embedded = await embedVietnameseFont(pdfDoc, options.fontBytes, { subset: options.subsetFont ?? true });
  if (embedded.missing.length > 0) {
    throw new PdfOverlayError(
      "FONT_GLYPH_MISSING",
      `Font thiếu glyph tiếng Việt: ${[...new Set(embedded.missing)].slice(0, 20).join(" ")}`,
    );
  }
  const measure = makeMeasure(embedded.pdfFont, embedded.fontkitFont);

  const pages: PageGeometry[] = [];
  for (let i = 0; i < pageCount; i++) {
    const page = pdfDoc.getPage(i);
    const { width, height } = page.getSize();
    pages.push({ pageNumber: i + 1, width, height, rotation: page.getRotation().angle });
  }

  let positionsDrawn = 0;
  const warnings: string[] = [];

  for (const pos of sortPositions(positions)) {
    if (pos.pageNumber < 1 || pos.pageNumber > pageCount) {
      throw new PdfOverlayError(
        "INVALID_PAGE_NUMBER",
        `pageNumber=${pos.pageNumber} ngoài [1..${pageCount}].`,
        { placeholder: pos.placeholder, pageNumber: pos.pageNumber },
      );
    }
    const page = pdfDoc.getPage(pos.pageNumber - 1);
    const geom = pages[pos.pageNumber - 1];

    if (!isBoxInsidePage(pos, geom.width, geom.height)) {
      throw new PdfOverlayError(
        "POSITION_OUT_OF_BOUNDS",
        `Box (${pos.x},${pos.y},${pos.width},${pos.height}) nằm ngoài trang ${pos.pageNumber} (${geom.width}×${geom.height}).`,
        { placeholder: pos.placeholder, pageNumber: pos.pageNumber },
      );
    }

    if (pos.whiteout) {
      page.drawRectangle({
        x: pos.x - WHITEOUT_PADDING_PT,
        y: pos.y - WHITEOUT_PADDING_PT,
        width: pos.width + WHITEOUT_PADDING_PT * 2,
        height: pos.height + WHITEOUT_PADDING_PT * 2,
        color: WHITE,
      });
    }

    if (CHECKBOX_POSITION_TYPES.includes(pos.type)) {
      const checked = checkboxStateFromValue(fieldValues[pos.placeholder]);
      drawCheckbox(page, pos, checked, pos.checkboxStyle ?? DEFAULT_CHECKBOX_STYLE);
      positionsDrawn += 1;
      continue;
    }

    if (pos.type === "IMAGE") {
      throw new PdfOverlayError("UNSUPPORTED_FIELD_TYPE", "type=IMAGE chưa hỗ trợ ở PR1.", { placeholder: pos.placeholder });
    }
    if (!TEXT_POSITION_TYPES.includes(pos.type) && pos.type !== "STATIC_TEXT") {
      throw new PdfOverlayError("UNSUPPORTED_FIELD_TYPE", `type=${pos.type} chưa hỗ trợ.`, { placeholder: pos.placeholder });
    }

    const value = pos.type === "STATIC_TEXT" ? (pos.staticText ?? "") : (fieldValues[pos.placeholder] ?? "");

    if (value.trim() === "") {
      if (pos.isRequired) {
        throw new PdfOverlayError(
          "MISSING_REQUIRED_FIELD",
          `placeholder=${pos.placeholder} bắt buộc nhưng không có giá trị.`,
          { placeholder: pos.placeholder, pageNumber: pos.pageNumber },
        );
      }
      continue; // optional rỗng → để trống có chủ đích
    }

    drawTextPosition(page, pos, value, embedded.pdfFont, measure);
    positionsDrawn += 1;
  }

  const bytes = await pdfDoc.save({ useObjectStreams: true });
  return {
    bytes,
    sha256: sha256Hex(bytes),
    pageCount,
    pages,
    positionsDrawn,
    warnings,
  };
}
