/**
 * Coordinate conversion + drag/resize normalization — tests (PR3).
 * Chạy trực tiếp trên mapper-coordinates.ts (module thuần). Bao phủ:
 * round-trip, drag giữ kích thước, resize từng handle, clamp biên, page switching,
 * multi-position placeholder.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  clampBoxToPage,
  cssBoxToPdf,
  dragBox,
  filterPositionsByPage,
  groupPositionsByPlaceholder,
  pdfBoxToCss,
  resizeBox,
  MIN_SIZE_PT,
  MIN_SIZE_CSS,
  type CssBox,
} from "./mapper-coordinates.ts";
import { A4_WIDTH_PT, A4_HEIGHT_PT } from "./geometry.ts";
import type { PageGeometry } from "./types.ts";

const A4: PageGeometry = { pageNumber: 1, width: A4_WIDTH_PT, height: A4_HEIGHT_PT, rotation: 0 };

test("cssBoxToPdf: đỉnh CSS → đáy PDF (bottom-left), kích thước / scale", () => {
  const scale = 1.5;
  const css: CssBox = { x: 100, y: 200, width: 300, height: 40 };
  const pdf = cssBoxToPdf(css, A4, scale);
  assert.ok(Math.abs(pdf.x - 100 / scale) < 1e-9);
  assert.ok(Math.abs(pdf.width - 300 / scale) < 1e-9);
  assert.ok(Math.abs(pdf.height - 40 / scale) < 1e-9);
  // y = pageHeight − (cssY + cssH)/scale
  assert.ok(Math.abs(pdf.y - (A4_HEIGHT_PT - (200 + 40) / scale)) < 1e-9);
});

test("round-trip: pdfBoxToCss(cssBoxToPdf(box)) == box", () => {
  const scale = 2.3;
  const css: CssBox = { x: 12.5, y: 88.25, width: 140.75, height: 30.5 };
  const back = pdfBoxToCss(cssBoxToPdf(css, A4, scale), A4, scale);
  assert.ok(Math.abs(back.x - css.x) < 1e-9);
  assert.ok(Math.abs(back.y - css.y) < 1e-9);
  assert.ok(Math.abs(back.width - css.width) < 1e-9);
  assert.ok(Math.abs(back.height - css.height) < 1e-9);
});

test("dragBox: giữ nguyên kích thước, chỉ đổi vị trí", () => {
  const scale = 2;
  const box = { x: 100, y: 700, width: 150, height: 20 };
  const moved = dragBox(box, A4, scale, 30, -40);
  assert.ok(Math.abs(moved.width - box.width) < 1e-9);
  assert.ok(Math.abs(moved.height - box.height) < 1e-9);
  // di chuyển +30px phải → +15pt; kéo lên -40px → y tăng 20pt
  assert.ok(Math.abs(moved.x - (box.x + 30 / scale)) < 1e-9);
  assert.ok(Math.abs(moved.y - (box.y + 40 / scale)) < 1e-9);
});

test("dragBox: không cho kéo ra ngoài trang (clamp biên)", () => {
  const scale = 1;
  const box = { x: 10, y: 10, width: 100, height: 20 };
  // kéo lên-trái → x về 0 (trái), y về đỉnh trang (page.height - height)
  const moved = dragBox(box, A4, scale, -999, -999);
  assert.equal(moved.x, 0);
  assert.ok(Math.abs(moved.y - (A4.height - box.height)) < 1e-9);
  // kéo xuống-phải → x về mép phải, y về 0 (đáy)
  const moved2 = dragBox(box, A4, scale, 9999, 9999);
  assert.ok(Math.abs(moved2.x + moved2.width - A4.width) < 1e-9);
  assert.equal(moved2.y, 0);
});

test("resizeBox: handle 'se' → giữ cạnh trái (x) + cạnh trên (y+height) cố định", () => {
  const scale = 2;
  const box = { x: 100, y: 700, width: 150, height: 20 };
  const resized = resizeBox(box, A4, scale, "se", 40, 20);
  // cạnh trái cố định
  assert.ok(Math.abs(resized.x - box.x) < 1e-9);
  // cạnh trên (y+height) cố định
  assert.ok(Math.abs(resized.y + resized.height - (box.y + box.height)) < 1e-9);
  // width +40px → +20pt; height +20px → +10pt
  assert.ok(Math.abs(resized.width - (box.width + 40 / scale)) < 1e-9);
  assert.ok(Math.abs(resized.height - (box.height + 20 / scale)) < 1e-9);
});

test("resizeBox: handle 'nw' → giữ cạnh phải (x+width) + cạnh dưới (y) cố định", () => {
  const scale = 1;
  const box = { x: 100, y: 700, width: 150, height: 20 };
  const resized = resizeBox(box, A4, scale, "nw", -20, -10);
  // cạnh phải cố định
  assert.ok(Math.abs(resized.x + resized.width - (box.x + box.width)) < 1e-9);
  // cạnh dưới (y) cố định
  assert.ok(Math.abs(resized.y - box.y) < 1e-9);
  // x giảm 20, width tăng 20; height tăng 10
  assert.ok(Math.abs(resized.x - (box.x - 20)) < 1e-9);
  assert.ok(Math.abs(resized.width - (box.width + 20)) < 1e-9);
  assert.ok(Math.abs(resized.height - (box.height + 10)) < 1e-9);
});

test("resizeBox: ép kích thước tối thiểu (không âm/0)", () => {
  const scale = 1;
  const box = { x: 100, y: 700, width: 150, height: 20 };
  const shrunk = resizeBox(box, A4, scale, "se", -9999, -9999);
  assert.ok(shrunk.width >= MIN_SIZE_PT - 1e-9);
  assert.ok(shrunk.height >= MIN_SIZE_PT - 1e-9);
});

test("clampBoxToPage: ép biên + kích thước tối thiểu", () => {
  const clamped = clampBoxToPage({ x: -50, y: -50, width: 0.5, height: 99999 }, A4);
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 0);
  assert.ok(clamped.width >= MIN_SIZE_PT);
  assert.ok(clamped.height <= A4.height + 1e-9);
});

test("filterPositionsByPage: lọc đúng page (1-based)", () => {
  const positions = [
    { placeholder: "A", pageNumber: 1 },
    { placeholder: "B", pageNumber: 2 },
    { placeholder: "C", pageNumber: 1 },
  ];
  assert.deepEqual(filterPositionsByPage(positions, 1).map((p) => p.placeholder), ["A", "C"]);
  assert.deepEqual(filterPositionsByPage(positions, 2).map((p) => p.placeholder), ["B"]);
  assert.deepEqual(filterPositionsByPage(positions, 3), []);
});

test("groupPositionsByPlaceholder: 1 placeholder nhiều position", () => {
  const positions = [
    { placeholder: "Ho_ten", pageNumber: 1 },
    { placeholder: "So_CCCD", pageNumber: 1 },
    { placeholder: "Ho_ten", pageNumber: 4 },
  ];
  const grouped = groupPositionsByPlaceholder(positions);
  assert.equal(grouped.get("Ho_ten")?.length, 2);
  assert.equal(grouped.get("So_CCCD")?.length, 1);
});

test("MIN_SIZE_CSS dùng cho thao tác UI", () => {
  assert.ok(MIN_SIZE_CSS > 0);
});
