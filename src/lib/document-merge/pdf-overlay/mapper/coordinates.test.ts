/**
 * PDF Overlay — Visual Mapper coordinate conversion tests (PR3).
 *
 * Bao phủ yêu cầu J của PR3: pixel↔PDF, bottom-left Y, zoom independence,
 * multi-page placement (per-page geometry), rotation. Các vector kỳ vọng được
 * xác minh thực nghiệm với pdfjs-dist 6.2.108 getViewport().convertToViewportPoint
 * (xem phần nhận xét trong coordinates.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  pdfPointToPixel,
  pixelToPdfPoint,
  ptToPixel,
  pixelToPt,
  pageDisplaySize,
  scaleToFitWidth,
  snapPdfCoordinate,
  pdfBoxToPixelBox,
  pixelBoxToPdfBox,
  type PageDimPt,
} from "./coordinates.ts";

const A4_PORTRAIT: PageDimPt = { width: 595.28, height: 841.89, rotation: 0 };

test("pdfPointToPixel: rotation 0 — bottom-left → top-left (Y đảo)", () => {
  // PDF (0,0) = góc dưới-trái → pixel (0, H·s) = góc dưới-trái canvas.
  assert.deepEqual(pdfPointToPixel({ x: 0, y: 0 }, A4_PORTRAIT, 1), { x: 0, y: 841.89 });
  // PDF (0,H) = góc trên-trái → pixel (0,0).
  assert.deepEqual(pdfPointToPixel({ x: 0, y: 841.89 }, A4_PORTRAIT, 1), { x: 0, y: 0 });
  // PDF (W,0) = góc dưới-phải → pixel (W, H).
  assert.deepEqual(pdfPointToPixel({ x: 595.28, y: 0 }, A4_PORTRAIT, 1), { x: 595.28, y: 841.89 });
});

test("bottom-left Y conversion: pixel↔PDF round-trip", () => {
  const pdfPt = { x: 120, y: 500 };
  const px = pdfPointToPixel(pdfPt, A4_PORTRAIT, 1);
  assert.deepEqual(px, { x: 120, y: 841.89 - 500 });
  const back = pixelToPdfPoint(px, A4_PORTRAIT, 1);
  assert.ok(Math.abs(back.x - pdfPt.x) < 1e-9);
  assert.ok(Math.abs(back.y - pdfPt.y) < 1e-9);
});

test("zoom independence: cùng tỷ lệ ở mọi scale", () => {
  for (const scale of [0.5, 1, 1.5, 2.5]) {
    const pt = { x: 100, y: 300 };
    const px = pdfPointToPixel(pt, A4_PORTRAIT, scale);
    // px ratio đúng bằng scale
    assert.ok(Math.abs(px.x - 100 * scale) < 1e-9);
    assert.ok(Math.abs(px.y - (841.89 - 300) * scale) < 1e-9);
    // round-trip khôi phục nguyên pt
    const back = pixelToPdfPoint(px, A4_PORTRAIT, scale);
    assert.ok(Math.abs(back.x - pt.x) < 1e-9);
    assert.ok(Math.abs(back.y - pt.y) < 1e-9);
  }
});

test("multi-page placement: mỗi trang có geometry riêng", () => {
  // Trang 1 A4 portrait, trang 2 A4 landscape (width/height đổi chỗ, rotation 0
  // theo cách pdf-lib lưu sau rotate page — ở đây dùng width/height trực tiếp).
  const landscape: PageDimPt = { width: 841.89, height: 595.28, rotation: 0 };
  const p = { x: 100, y: 100 };
  const p1 = pdfPointToPixel(p, A4_PORTRAIT, 1);
  const p2 = pdfPointToPixel(p, landscape, 1);
  // Cùng y=100 nhưng H khác → pixel Y khác nhau → chứng minh per-page geometry.
  assert.notDeepEqual(p1, p2);
  assert.equal(p1.y, 841.89 - 100);
  assert.equal(p2.y, 595.28 - 100);
  // round-trip theo đúng geometry từng trang
  assert.deepEqual(pixelToPdfPoint(p1, A4_PORTRAIT, 1), { x: 100, y: 100 });
  assert.deepEqual(pixelToPdfPoint(p2, landscape, 1), { x: 100, y: 100 });
});

test("rotation 90/180/270 — khớp pdf.js viewport transform", () => {
  // Các vector kỳ vọng từ getViewport(scale=1).convertToViewportPoint:
  // rot 90: PDF(0,0)->[0,0]; PDF(595.28,841.89)->[841.89,595.28]
  const r90: PageDimPt = { width: 595.28, height: 841.89, rotation: 90 };
  assert.deepEqual(pdfPointToPixel({ x: 0, y: 0 }, r90, 1), { x: 0, y: 0 });
  assert.deepEqual(pdfPointToPixel({ x: 595.28, y: 841.89 }, r90, 1), { x: 841.89, y: 595.28 });
  // round-trip
  const back = pixelToPdfPoint({ x: 841.89, y: 595.28 }, r90, 1);
  assert.ok(Math.abs(back.x - 595.28) < 1e-9);
  assert.ok(Math.abs(back.y - 841.89) < 1e-9);

  // rot 180: PDF(0,0)->[W,0]; PDF(W,H)->[0,H]
  const r180: PageDimPt = { width: 595.28, height: 841.89, rotation: 180 };
  assert.deepEqual(pdfPointToPixel({ x: 0, y: 0 }, r180, 1), { x: 595.28, y: 0 });
  assert.deepEqual(pdfPointToPixel({ x: 595.28, y: 841.89 }, r180, 1), { x: 0, y: 841.89 });

  // rot 270: PDF(0,0)->[H,W]; PDF(W,H)->[0,0]
  const r270: PageDimPt = { width: 595.28, height: 841.89, rotation: 270 };
  assert.deepEqual(pdfPointToPixel({ x: 0, y: 0 }, r270, 1), { x: 841.89, y: 595.28 });
  assert.deepEqual(pdfPointToPixel({ x: 595.28, y: 841.89 }, r270, 1), { x: 0, y: 0 });
});

test("rotation không hợp lệ thì throw", () => {
  assert.throws(() => pdfPointToPixel({ x: 1, y: 1 }, { ...A4_PORTRAIT, rotation: 45 } as unknown as PageDimPt, 1));
  assert.throws(() => pixelToPdfPoint({ x: 1, y: 1 }, { ...A4_PORTRAIT, rotation: 45 } as unknown as PageDimPt, 1));
});

test("ptToPixel / pixelToPt — độ dài tuyến tính theo scale", () => {
  assert.equal(ptToPixel(10, 2), 20);
  assert.equal(ptToPixel(10, 0.5), 5);
  assert.equal(pixelToPt(20, 2), 10);
  assert.equal(pixelToPt(5, 0.5), 10);
});

test("pageDisplaySize — rotation 90/270 hoán đổi width/height", () => {
  assert.deepEqual(pageDisplaySize(A4_PORTRAIT, 1), { width: 595.28, height: 841.89 });
  assert.deepEqual(pageDisplaySize({ ...A4_PORTRAIT, rotation: 90 }, 1), { width: 841.89, height: 595.28 });
  assert.deepEqual(pageDisplaySize({ ...A4_PORTRAIT, rotation: 270 }, 2), { width: 1683.78, height: 1190.56 });
});

test("scaleToFitWidth — fit width giữ đúng aspect ratio", () => {
  const s = scaleToFitWidth(A4_PORTRAIT, 300);
  assert.ok(Math.abs(s - 300 / 595.28) < 1e-9);
  // fit width nhỏ hơn trang → tỷ lệ < 1
  assert.ok(s < 1);
  // input vô nghĩa → 1 (an toàn)
  assert.equal(scaleToFitWidth(A4_PORTRAIT, 0), 1);
  assert.equal(scaleToFitWidth(A4_PORTRAIT, -5), 1);
});

test("snapPdfCoordinate — bỏ noise float, giữ value hợp lệ", () => {
  assert.equal(snapPdfCoordinate(595.2800000001), 595.28);
  assert.equal(snapPdfCoordinate(10.12345, 2), 10.12);
  assert.equal(snapPdfCoordinate(Number.NaN), Number.NaN);
});

test("pdfBoxToPixelBox / pixelBoxToPdfBox — box round-trip (drag/resize)", () => {
  const box = { x: 50, y: 700, width: 200, height: 20 };
  for (const scale of [1, 2, 0.75]) {
    const css = pdfBoxToPixelBox(box, A4_PORTRAIT, scale);
    // pixel box: top-left, nên y nhỏ hơn (vì PDF y lớn → pixel y nhỏ)
    assert.equal(css.left, 50 * scale);
    assert.equal(css.top, (841.89 - 720) * scale);
    assert.equal(css.width, 200 * scale);
    assert.equal(css.height, 20 * scale);
    const back = pixelBoxToPdfBox(css, A4_PORTRAIT, scale);
    assert.ok(Math.abs(back.x - box.x) < 1e-9);
    assert.ok(Math.abs(back.y - box.y) < 1e-9);
    assert.ok(Math.abs(back.width - box.width) < 1e-9);
    assert.ok(Math.abs(back.height - box.height) < 1e-9);
  }
});
