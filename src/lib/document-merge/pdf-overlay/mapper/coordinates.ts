/**
 * PDF Overlay — Visual Mapper coordinate conversion (PR3, management layer).
 *
 * MỘT hệ quy chiếu duy nhất được chia sẻ giữa browser mapper và renderer (PR1):
 *
 *   - LƯU TRỮ / API: PDF user-space points, gốc BOTTOM-LEFT (đúng PR1 geometry.ts).
 *       x/y của box = góc dưới-trái, width/height tính bằng pt (1pt = 1/72 inch).
 *   - HIỂN THỊ (browser): pixel, gốc TOP-LEFT (canvas/SVG của trình duyệt).
 *
 * Module này THUẦN (không import pdf.js/DOMMatrix/DOM) để chạy được trong
 * node --test. Công thức khớp chính xác với pdf.js `PDFPageProxy.getViewport().convertToViewportPoint`
 * (đã xác minh bằng thực nghiệm trên pdfjs-dist 6.2.108 — xem coordinates.test.ts).
 *
 * Có hỗ trợ rotation trang (0/90/180/270). Mọi box mapper gửi lên đều được
 * chuyển VỀ pt bottom-left trước khi gọi PR2 service — mapper KHÔNG bao giờ
 * lưu pixel/CSS px.
 */

/**
 * Rotation trang hợp lệ theo PR1 (geometry.ts::isValidRotation).
 * PageLayout của pdf_template_versions lưu `rotation` từng trang (pdf-lib
 * `page.getRotation().angle`).
 */
export type PageRotation = 0 | 90 | 180 | 270;

export interface PageDimPt {
  /** width của trang TRONG hệ PDF gốc (trước rotation), đơn vị pt. */
  width: number;
  /** height của trang TRONG hệ PDF gốc (trước rotation), đơn vị pt. */
  height: number;
  /** rotation trang (deg, clockwise). */
  rotation: PageRotation;
}

export interface PixelPoint {
  x: number;
  y: number;
}

export interface PdfPoint {
  x: number;
  y: number;
}

const VALID_ROTATIONS: readonly number[] = [0, 90, 180, 270];

function assertValidRotation(rotation: number): asserts rotation is PageRotation {
  if (!VALID_ROTATIONS.includes(rotation)) {
    throw new Error(`GEOMETRY_INVALID_ROTATION: ${rotation}`);
  }
}

/**
 * Chuyển 1 điểm PDF (pt, gốc bottom-left) → pixel hiển thị (gốc top-left).
 * `scale` = số pixel / 1 pt (viewport scale của pdf.js).
 * Công thức khớp pdf.js convertToViewportPoint:
 *   rot 0:   px =  x·s          ; py = (H − y)·s
 *   rot 90:  px =  y·s          ; py =  x·s
 *   rot 180: px = (W − x)·s     ; py =  y·s
 *   rot 270: px = (H − y)·s     ; py = (W − x)·s
 */
export function pdfPointToPixel(
  pt: PdfPoint,
  page: PageDimPt,
  scale: number,
): PixelPoint {
  assertValidRotation(page.rotation);
  const { width: W, height: H, rotation } = page;
  const { x, y } = pt;
  switch (rotation) {
    case 0:
      return { x: x * scale, y: (H - y) * scale };
    case 90:
      return { x: y * scale, y: x * scale };
    case 180:
      return { x: (W - x) * scale, y: y * scale };
    case 270:
      return { x: (H - y) * scale, y: (W - x) * scale };
  }
}

/**
 * Chuyển 1 điểm pixel (gốc top-left) → PDF (pt, gốc bottom-left).
 * Nghịch đảo của pdfPointToPixel — dùng khi drag/resize để lưu về pt.
 */
export function pixelToPdfPoint(
  px: PixelPoint,
  page: PageDimPt,
  scale: number,
): PdfPoint {
  assertValidRotation(page.rotation);
  const { width: W, height: H, rotation } = page;
  const { x, y } = px;
  switch (rotation) {
    case 0:
      return { x: x / scale, y: H - y / scale };
    case 90:
      return { x: y / scale, y: x / scale };
    case 180:
      return { x: W - x / scale, y: y / scale };
    case 270:
      return { x: H - y / scale, y: W - x / scale };
  }
}

/** Chuyển 1 độ dài pt → pixel (không phụ thuộc rotation). */
export function ptToPixel(lengthPt: number, scale: number): number {
  return lengthPt * scale;
}

/** Chuyển 1 độ dài pixel → pt (không phụ thuộc rotation). */
export function pixelToPt(lengthPx: number, scale: number): number {
  return lengthPx / scale;
}

/** Kích thước hiển thị (pixel) của 1 trang sau rotation ở scale cho trước. */
export function pageDisplaySize(
  page: PageDimPt,
  scale: number,
): { width: number; height: number } {
  assertValidRotation(page.rotation);
  const { width: W, height: H, rotation } = page;
  if (rotation === 90 || rotation === 270) {
    return { width: H * scale, height: W * scale };
  }
  return { width: W * scale, height: H * scale };
}

/**
 * Tính scale (pixel/pt) để page hiển thị vừa theo `fitWidth` pixel (fit width).
 * Trả về scale dương; nếu fitWidth <= 0 hoặc width pt <= 0 → 1 (an toàn).
 */
export function scaleToFitWidth(page: PageDimPt, fitWidth: number): number {
  const { width } = pageDisplaySize(page, 1);
  if (!(fitWidth > 0) || !(width > 0)) return 1;
  return fitWidth / width;
}

/**
 * Làm tròn box PDF về sai số an toàn (tránh float noise 595.2800000001 v.v.).
 * Không thay đổi value ngoài ngưỡng.
 */
export function snapPdfCoordinate(value: number, precision = 3): number {
  if (!Number.isFinite(value)) return value;
  const p = Math.pow(10, precision);
  return Math.round(value * p) / p;
}

/** Chuyển 1 box PDF (pt, bottom-left) → CSS (pixel, top-left) cho overlay div. */
export function pdfBoxToPixelBox(
  box: { x: number; y: number; width: number; height: number },
  page: PageDimPt,
  scale: number,
): { left: number; top: number; width: number; height: number } {
  const { x, y } = pdfPointToPixel({ x: box.x, y: box.y }, page, scale);
  const { x: x2, y: y2 } = pdfPointToPixel(
    { x: box.x + box.width, y: box.y + box.height },
    page,
    scale,
  );
  return {
    left: Math.min(x, x2),
    top: Math.min(y, y2),
    width: Math.abs(x2 - x),
    height: Math.abs(y2 - y),
  };
}

/** Nghịch đảo: CSS box (pixel, top-left) → PDF box (pt, bottom-left). */
export function pixelBoxToPdfBox(
  css: { left: number; top: number; width: number; height: number },
  page: PageDimPt,
  scale: number,
): { x: number; y: number; width: number; height: number } {
  const p1 = pixelToPdfPoint({ x: css.left, y: css.top }, page, scale);
  const p2 = pixelToPdfPoint(
    { x: css.left + css.width, y: css.top + css.height },
    page,
    scale,
  );
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    width: Math.abs(p2.x - p1.x),
    height: Math.abs(p2.y - p1.y),
  };
}
