/**
 * PDF Overlay — Preview renderer (PR3, client-side, in-memory).
 *
 * Tạo PDF xem trước AN TOÀN trong trình duyệt: load blank PDF bytes + font,
 * vẽ SAMPLE VALUES lên boxes, trả bytes PDF mới — KHÔNG đọc Production candidate,
 * KHÔNG tạo merge job, KHÔNG mutate Production, KHÔNG gọi renderer production
 * (renderer.ts dùng node:crypto — không chạy ở browser).
 *
 * Chỉ để Admin XEM TRƯỚC layout. Vẽ đơn giản (wrap + align) — không phải text-fit
 * engine production. Tọa độ = pt gốc bottom-left (PR1).
 */

import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { checkboxStateFromValue } from "@/lib/document-merge/pdf-overlay/mapper/checkbox-state";
import type { EditorPosition } from "@/lib/document-merge/pdf-overlay/mapper/serialization";

export interface PreviewRenderResult {
  bytes: Uint8Array;
  error: string | null;
}

/**
 * @param blankPdfBytes bytes PDF nền
 * @param positions các position (pt bottom-left)
 * @param sampleValues value mẫu theo placeholder
 * @param fontBytes bytes DejaVuSans.ttf
 */
export async function renderPreviewPdf(
  blankPdfBytes: ArrayBuffer,
  positions: EditorPosition[],
  sampleValues: Record<string, string>,
  fontBytes: ArrayBuffer,
): Promise<PreviewRenderResult> {
  try {
    const doc = await PDFDocument.load(blankPdfBytes, { updateMetadata: false, ignoreEncryption: false });
    const font = await embedFont(doc, new Uint8Array(fontBytes));

    for (const pos of positions) {
      const page = doc.getPage(pos.pageNumber - 1);
      if (!page) continue;

      const isCheckbox = pos.type === "CHECKBOX" || pos.type === "RADIO_OPTION";
      if (isCheckbox) {
        const value = sampleValues[pos.placeholder] ?? "";
        const checked = checkboxStateFromValue(value);
        drawCheckbox(page, pos, checked, pos.checkboxStyle ?? "SQUARE_X");
        continue;
      }

      const text = pos.type === "STATIC_TEXT" ? (pos.staticText ?? "") : (sampleValues[pos.placeholder] ?? "");
      if (!text) continue;
      drawText(page, pos, text, font);
    }

    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, error: null };
  } catch (err) {
    return { bytes: new Uint8Array(), error: err instanceof Error ? err.message : "Không render được preview." };
  }
}

async function embedFont(doc: PDFDocument, fontBytes: Uint8Array): Promise<PDFFont> {
  (doc as unknown as { registerFontkit: (f: unknown) => void }).registerFontkit(fontkit as never);
  return doc.embedFont(fontBytes, { subset: false });
}

/** Vẽ text wrap + align/valign trong box (đơn giản). */
function drawText(page: import("pdf-lib").PDFPage, pos: EditorPosition, text: string, font: PDFFont): void {
  const fontSize = pos.fontSize ?? 10;
  const lineHeight = fontSize * 1.25;
  const maxWidth = pos.width - 2;
  const align = pos.align ?? "left";
  const valign = pos.valign ?? "top";
  const multiline = pos.multiline ?? false;

  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const para of paragraphs) {
    if (multiline) {
      const words = para.split(/\s+/).filter(Boolean);
      let line = "";
      for (const w of words) {
        const candidate = line ? line + " " + w : w;
        if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth || !line) line = candidate;
        else {
          lines.push(line);
          line = w;
        }
      }
      if (line) lines.push(line);
    } else {
      lines.push(para);
    }
  }
  if (lines.length === 0) return;

  const blockHeight = lines.length * lineHeight;
  const ascent = fontSize * 0.8;
  let blockTop: number;
  if (valign === "middle") blockTop = pos.y + (pos.height - blockHeight) / 2 + ascent;
  else if (valign === "bottom") blockTop = pos.y + pos.height - blockHeight + ascent;
  else blockTop = pos.y + pos.height - ascent;

  let baseline = blockTop;
  for (const line of lines) {
    const textW = font.widthOfTextAtSize(line, fontSize);
    let x: number;
    if (align === "center") x = pos.x + (pos.width - textW) / 2;
    else if (align === "right") x = pos.x + pos.width - textW;
    else x = pos.x;
    page.drawText(line, { x, y: baseline, size: fontSize, font, color: rgb(0, 0, 0) });
    baseline -= lineHeight;
  }
}

/** Vẽ checkbox/radio bằng vector (không glyph). */
function drawCheckbox(page: import("pdf-lib").PDFPage, pos: EditorPosition, checked: boolean, style: string): void {
  const size = Math.min(pos.width, pos.height);
  const cx = pos.x + pos.width / 2;
  const cy = pos.y + pos.height / 2;
  const half = size / 2;
  const lw = Math.max(0.5, Math.round(size * 0.08 * 10) / 10);
  const black = rgb(0, 0, 0);

  if (style === "CIRCLE_DOT") {
    page.drawEllipse({ x: cx - half, y: cy - half, xScale: half, yScale: half, borderColor: black, borderWidth: lw });
    if (checked) {
      const dot = half * 0.45;
      page.drawEllipse({ x: cx - dot, y: cy - dot, xScale: dot, yScale: dot, color: black });
    }
    return;
  }

  page.drawRectangle({ x: cx - half, y: cy - half, width: size, height: size, borderColor: black, borderWidth: lw });
  if (!checked) return;

  const inset = half * 0.25;
  const l = cx - half + inset;
  const r = cx + half - inset;
  const b = cy - half + inset;
  const t = cy + half - inset;

  if (style === "SQUARE_X") {
    page.drawLine({ start: { x: l, y: b }, end: { x: r, y: t }, thickness: lw, color: black });
    page.drawLine({ start: { x: r, y: b }, end: { x: l, y: t }, thickness: lw, color: black });
  } else if (style === "SQUARE_TICK") {
    page.drawLine({ start: { x: l, y: cy - half * 0.1 }, end: { x: cx - half * 0.15, y: b + half * 0.35 }, thickness: lw, color: black });
    page.drawLine({ start: { x: cx - half * 0.15, y: b + half * 0.35 }, end: { x: r, y: t }, thickness: lw, color: black });
  } else {
    page.drawRectangle({ x: l, y: b, width: r - l, height: t - b, color: black });
  }
}
