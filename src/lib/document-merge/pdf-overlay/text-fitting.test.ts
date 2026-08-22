import test from "node:test";
import assert from "node:assert/strict";

import {
  ellipsizeToWidth,
  fitText,
  layoutFittedText,
  wrapParagraph,
  type MeasureFont,
} from "./text-fitting.ts";

/** Stub đo text xác định: mỗi ký tự = size * 0.5 pt (không phụ thuộc font thật). */
const measure: MeasureFont = {
  widthOfText: (t, s) => t.length * s * 0.5,
  ascentAt: (s) => s * 0.8,
  descentAt: (s) => s * 0.2,
  lineHeightAt: (s) => s * 1.2,
};

const BOX = { x: 0, y: 0, width: 100, height: 60 };

test("text-fitting: single line vừa width → giữ nguyên fontSize, 1 dòng", () => {
  const r = fitText({ text: "ABC", box: BOX, fontSize: 10, align: "left", valign: "top", multiline: false, measure });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fontSize, 10);
    assert.deepEqual(r.lines, ["ABC"]);
  }
});

test("text-fitting: shrink khi tràn — 10pt → 6pt cho vừa box", () => {
  // "ABCDEFGHIJ" (10 ký tự): width = 10 * size * 0.5 = 5*size. Box width 30 → size ≤ 6.
  const r = fitText({
    text: "ABCDEFGHIJ",
    box: { x: 0, y: 0, width: 30, height: 60 },
    fontSize: 10,
    minFontSize: 6,
    align: "left",
    valign: "top",
    multiline: false,
    measure,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fontSize, 6);
    assert.deepEqual(r.lines, ["ABCDEFGHIJ"]);
  }
});

test("text-fitting: vẫn tràn ở minFontSize → OVERFLOW xác định", () => {
  const r = fitText({
    text: "ABCDEFGHIJ",
    box: { x: 0, y: 0, width: 20, height: 60 },
    fontSize: 10,
    minFontSize: 6,
    align: "left",
    valign: "top",
    multiline: false,
    measure,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "OVERFLOW");
});

test("text-fitting: wrapParagraph cắt theo khoảng trắng", () => {
  // size 10 → mỗi ký tự = 5pt. maxWidth 15 → mỗi dòng ≤ 3 ký tự.
  const lines = wrapParagraph("aa bb cc", 15, 10, measure);
  assert.deepEqual(lines, ["aa", "bb", "cc"]);
});

test("text-fitting: địa chỉ dài wrap thành nhiều dòng, dòng nào cũng ≤ width", () => {
  const maxWidth = 40;
  const lines = wrapParagraph("Số 12 đường Trần Phú phường 3 TP Đà Lạt", maxWidth, 10, measure);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(measure.widthOfText(line, 10) <= maxWidth, `line "${line}" vượt width`);
  }
});

test("text-fitting: maxLines giới hạn số dòng — tràn → OVERFLOW (không shrink)", () => {
  const r = fitText({
    text: "aa bb cc",
    box: { x: 0, y: 0, width: 15, height: 60 },
    fontSize: 10,
    minFontSize: 10, // không cho shrink
    align: "left",
    valign: "top",
    multiline: true,
    maxLines: 2,
    measure,
  });
  assert.equal(r.ok, false);
});

test("text-fitting: multiline cho phép xuống dòng cứng (\\n)", () => {
  const r = fitText({
    text: "Dòng một\nDòng hai",
    box: { x: 0, y: 0, width: 200, height: 60 },
    fontSize: 10,
    align: "left",
    valign: "top",
    multiline: true,
    measure,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.lines.length >= 2);
});

test("text-fitting: text rỗng → OVERFLOW (caller bỏ qua)", () => {
  const r = fitText({ text: "", box: BOX, fontSize: 10, align: "left", valign: "top", multiline: false, measure });
  assert.equal(r.ok, false);
});

test("text-fitting: layout — align center/right + valign top/bottom", () => {
  const fit = fitText({
    text: "AB",
    box: { x: 100, y: 200, width: 100, height: 50 },
    fontSize: 10,
    align: "left",
    valign: "top",
    multiline: false,
    measure,
  });
  assert.equal(fit.ok, true);
  if (!fit.ok) return;

  const center = layoutFittedText(fit, { x: 100, y: 200, width: 100, height: 50 }, "center", "top", measure);
  // "AB" width = 10 → center x = 100 + (100-10)/2 = 145
  assert.equal(center[0].x, 145);

  const right = layoutFittedText(fit, { x: 100, y: 200, width: 100, height: 50 }, "right", "top", measure);
  assert.equal(right[0].x, 190); // 100 + 100 - 10

  // valign top: baseline = topY - ascent = 250 - 8 = 242
  assert.equal(center[0].baselineY, 242);
});

test("text-fitting: ellipsizeToWidth cắt cuối + thêm '…' cho vừa width", () => {
  // "ABCDEFGHIJ" width ở size 10 = 50. width mục tiêu 25 → giữ tối đa 4 ký tự + "…".
  const out = ellipsizeToWidth("ABCDEFGHIJ", 25, 10, measure);
  assert.ok(out.endsWith("…"));
  assert.ok(measure.widthOfText(out, 10) <= 25);
});
