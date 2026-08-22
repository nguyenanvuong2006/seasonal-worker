/**
 * PDF Overlay Engine — text fitting (PR1). THUẦN (không import pdf-lib).
 *
 * Mỗi text field có 1 bounding box cố định. Thuật toán:
 *   try fontSize → wrap theo width → nếu tràn → shrink từng bước (0.5pt)
 *   → lặp tới minFontSize → nếu vẫn tràn: FAIL xác định (FIELD_OVERFLOW).
 *
 * KHÔNG bao giờ cắt lén nội dung bắt buộc. `MeasureFont` trừu tượng để test
 * được mà không cần font thật — renderer nạp adapter từ PDFFont + fontkit.
 */

import type { Align, PdfBox, Valign } from "./types.ts";

export const SHRINK_STEP_PT = 0.5;

/** Trừu tượng đo text — renderer cấp adapter từ PDFFont (width) + fontkit (metrics). */
export interface MeasureFont {
  widthOfText(text: string, size: number): number;
  ascentAt(size: number): number;
  descentAt(size: number): number;
  lineHeightAt(size: number): number;
}

export interface FittedText {
  ok: true;
  fontSize: number;
  lines: string[];
  lineHeight: number;
  ascent: number;
  descent: number;
}

export interface FitFailure {
  ok: false;
  reason: "OVERFLOW";
}

export type FitTextResult = FittedText | FitFailure;

export interface FitTextInput {
  text: string;
  box: PdfBox;
  fontSize: number;
  minFontSize?: number;
  align: Align;
  valign: Valign;
  multiline: boolean;
  maxLines?: number | null;
  measure: MeasureFont;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Wrap một đoạn (paragraph) thành các dòng theo maxWidth.
 * - Cắt theo khoảng trắng; từ đơn dài hơn maxWidth bị bẻ theo ký tự
 *   (số tài khoản ngân hàng, chuỗi không khoảng trắng).
 */
export function wrapParagraph(paragraph: string, maxWidth: number, size: number, measure: MeasureFont): string[] {
  if (paragraph === "") return [""];
  const words = paragraph.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (measure.widthOfText(candidate, size) <= maxWidth) {
      current = candidate;
    } else if (current !== "") {
      lines.push(current);
      current = word;
    } else {
      // Một "từ" đơn đã dài hơn maxWidth → bẻ theo ký tự.
      let chunk = "";
      for (const ch of word) {
        const next = chunk + ch;
        if (measure.widthOfText(next, size) <= maxWidth || chunk === "") {
          chunk = next;
        } else {
          lines.push(chunk);
          chunk = ch;
        }
      }
      current = chunk;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Trải text thành các dòng theo cấu hình. Trả null khi tràn. */
function tryFit(input: FitTextInput, size: number): string[] | null {
  const { text, box, multiline, maxLines, measure } = input;
  let lines: string[];

  if (multiline) {
    lines = [];
    for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
      lines.push(...wrapParagraph(paragraph, box.width, size, measure));
    }
  } else {
    // Không multiline: toàn bộ là 1 dòng (xuống dòng bị gộp thành khoảng trắng).
    const single = text.replace(/\s*\r?\n\s*/g, " ").trimEnd();
    lines = single === "" ? [""] : [single];
    if (measure.widthOfText(single, size) > box.width) return null;
  }

  if (maxLines !== null && maxLines !== undefined && lines.length > maxLines) return null;
  return lines;
}

/** Fit text vào box — trả kết quả xác định (font size + lines) hoặc OVERFLOW. */
export function fitText(input: FitTextInput): FitTextResult {
  const { text, fontSize, minFontSize, measure } = input;
  if (text === "") return { ok: false, reason: "OVERFLOW" }; // rỗng → caller bỏ qua

  const maxSize = fontSize;
  const minSize = minFontSize !== undefined && minFontSize !== null ? minFontSize : fontSize;

  let size = maxSize;
  let lines: string[] | null = null;

  // Lặp shrink xác định (không random, không jitter).
  while (true) {
    const fitted = tryFit(input, size);
    if (fitted !== null) {
      lines = fitted;
      break;
    }
    if (size <= minSize + 1e-9) break;
    size = round2(Math.max(minSize, size - SHRINK_STEP_PT));
  }

  if (lines === null) return { ok: false, reason: "OVERFLOW" };

  return {
    ok: true,
    fontSize: size,
    lines,
    lineHeight: round2(measure.lineHeightAt(size)),
    ascent: round2(measure.ascentAt(size)),
    descent: round2(measure.descentAt(size)),
  };
}

export interface LineLayout {
  line: string;
  x: number;
  baselineY: number;
}

/**
 * Bố cục từng dòng trong box theo align/valign (baseline Y tính theo gốc bottom-left).
 * KHÔNG vẽ gì ở đây — renderer gọi page.drawText với các giá trị này.
 */
export function layoutFittedText(
  fit: FittedText,
  box: PdfBox,
  align: Align,
  valign: Valign,
  measure: MeasureFont,
): LineLayout[] {
  const n = fit.lines.length;
  const ascent = fit.ascent;
  const descent = fit.descent;
  const lineHeight = fit.lineHeight;

  const totalHeight = (n - 1) * lineHeight + ascent + descent;
  const topY = box.y + box.height;

  let firstBaseline = topY - ascent;
  if (valign === "bottom") {
    firstBaseline -= Math.max(0, totalHeight - box.height);
  } else if (valign === "middle") {
    firstBaseline -= Math.max(0, totalHeight - box.height) / 2;
  }

  return fit.lines.map((line, i) => {
    const width = measure.widthOfText(line, fit.fontSize);
    let x = box.x;
    if (align === "center") x = box.x + (box.width - width) / 2;
    else if (align === "right") x = box.x + box.width - width;
    return { line, x: round2(x), baselineY: round2(firstBaseline - i * lineHeight) };
  });
}

/**
 * Cắt lén cuối dòng + thêm "…" cho đúng width — CHỈ dùng cho optional field
 * với overflowPolicy=ELLIPSIZE (bắt buộc KHÔNG bao giờ dùng).
 */
export function ellipsizeToWidth(text: string, width: number, size: number, measure: MeasureFont): string {
  const ellipsis = "…";
  if (measure.widthOfText(text, size) <= width) return text;
  let truncated = text;
  while (truncated.length > 0 && measure.widthOfText(truncated + ellipsis, size) > width) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + ellipsis;
}
