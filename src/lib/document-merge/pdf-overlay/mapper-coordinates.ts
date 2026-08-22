/**
 * PDF Overlay Mapper — coordinate conversion + drag/resize normalization (PR3).
 *
 * Hàm THUẦN (không React, không DB, không pdfjs) để test được bằng node --test
 * và dùng chung bởi UI mapper. Đây là NƠI DUY NHẤT quy đổi giữa 2 hệ tọa độ:
 *
 *   - PDF space (authoritative, lưu DB): user-space points, gốc BOTTOM-LEFT,
 *     x/y = góc dưới-trái của box. (khớp renderer pdf-lib + pdf_field_positions)
 *   - CSS space (browser canvas): pixel, gốc TOP-LEFT, x/y = góc trên-trái.
 *
 * scale = rendered CSS width / page width (points) = pdf.js render scale.
 *
 * Nguyên tắc chống drift: DB LUÔN giữ PDF points (source of truth). UI chỉ đọc
 * CSS px trong lúc kéo/thả rồi quy đổi MỘT LẦN về PDF points qua cssBoxToPdf —
 * không bao giờ cộng dồn delta kiểu float nhiều lần.
 */

import type { PageGeometry, PdfBox } from "./types.ts";

/** Kích thước tối thiểu của 1 box (tránh 0/âm khi resize). */
export const MIN_SIZE_PT = 2;
export const MIN_SIZE_CSS = 6;

/** Box trong CSS pixel (gốc top-left). */
export interface CssBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

/**
 * CSS (top-left px) → PDF (bottom-left pt).
 * yPt = pageHeightPt − (cssY + cssH)/scale  (đáy box ở CSS → khoảng cách từ đáy trang).
 */
export function cssBoxToPdf(box: CssBox, page: PageGeometry, scale: number): PdfBox {
  return {
    x: box.x / scale,
    y: page.height - (box.y + box.height) / scale,
    width: box.width / scale,
    height: box.height / scale,
  };
}

/** PDF (bottom-left pt) → CSS (top-left px). Nghịch đảo chính xác của cssBoxToPdf. */
export function pdfBoxToCss(box: PdfBox, page: PageGeometry, scale: number): CssBox {
  return {
    x: box.x * scale,
    y: (page.height - box.y - box.height) * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
}

/** Snap box vào trong trang (chặn vượt biên + kích thước < tối thiểu / > trang). */
export function clampBoxToPage(box: PdfBox, page: PageGeometry): PdfBox {
  const width = Math.min(Math.max(MIN_SIZE_PT, box.width), page.width);
  const height = Math.min(Math.max(MIN_SIZE_PT, box.height), page.height);
  const x = Math.min(Math.max(0, box.x), page.width - width);
  const y = Math.min(Math.max(0, box.y), page.height - height);
  return { x, y, width, height };
}

/** Kéo box nguyên vẹn (giữ kích thước) theo delta CSS px. */
export function dragBox(box: PdfBox, page: PageGeometry, scale: number, dx: number, dy: number): PdfBox {
  const css = pdfBoxToCss(box, page, scale);
  return clampBoxToPage(
    cssBoxToPdf({ x: css.x + dx, y: css.y + dy, width: css.width, height: css.height }, page, scale),
    page,
  );
}

/**
 * Resize box theo handle (nw/ne/sw/se) với delta chuột CSS px.
 * Cạnh đối diện handle được giữ cố định; kích thước tối thiểu được ép.
 */
export function resizeBox(
  box: PdfBox,
  page: PageGeometry,
  scale: number,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): PdfBox {
  const css = pdfBoxToCss(box, page, scale);
  let left = css.x;
  let top = css.y;
  let right = css.x + css.width;
  let bottom = css.y + css.height;

  // handle "nw"/"ne"/"sw"/"se": "w/e" = trái/phải (x), "n/s" = trên/dưới (y).
  if (handle.includes("w")) left += dx;
  else if (handle.includes("e")) right += dx;
  if (handle.includes("n")) top += dy;
  else if (handle.includes("s")) bottom += dy;

  if (right - left < MIN_SIZE_CSS) {
    if (handle.includes("w")) left = right - MIN_SIZE_CSS;
    else right = left + MIN_SIZE_CSS;
  }
  if (bottom - top < MIN_SIZE_CSS) {
    if (handle.includes("n")) top = bottom - MIN_SIZE_CSS;
    else bottom = top + MIN_SIZE_CSS;
  }

  return clampBoxToPage(
    cssBoxToPdf({ x: left, y: top, width: right - left, height: bottom - top }, page, scale),
    page,
  );
}

/** Lọc positions theo page (1-based). */
export function filterPositionsByPage<T extends { pageNumber: number }>(positions: T[], pageNumber: number): T[] {
  return positions.filter((p) => p.pageNumber === pageNumber);
}

/** Nhóm positions theo placeholder — hỗ trợ 1 placeholder nhiều position/page. */
export function groupPositionsByPlaceholder<T extends { placeholder: string }>(positions: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const p of positions) {
    const list = map.get(p.placeholder);
    if (list) list.push(p);
    else map.set(p.placeholder, [p]);
  }
  return map;
}
