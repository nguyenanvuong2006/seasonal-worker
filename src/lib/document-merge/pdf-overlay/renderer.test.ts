import test from "node:test";
import assert from "node:assert/strict";

import { PDFDocument } from "pdf-lib";

import { A4_HEIGHT_PT, A4_WIDTH_PT } from "./geometry.ts";
import { checkboxStateFromValue, renderPdfOverlay, sha256Hex } from "./renderer.ts";
import { PdfOverlayError, type PdfPositionSpec } from "./types.ts";
import { readEmbeddedFontBytes } from "./vietnamese-font.ts";

const fontBytes = readEmbeddedFontBytes();

async function makeTemplate(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
  return doc.save({ useObjectStreams: true });
}

function textPos(overrides: Partial<PdfPositionSpec> = {}): PdfPositionSpec {
  return {
    placeholder: "Ho_ten",
    pageNumber: 1,
    x: 50,
    y: 700,
    width: 200,
    height: 20,
    type: "TEXT",
    fontSize: 10,
    ...overrides,
  };
}

function render(template: Uint8Array, positions: PdfPositionSpec[], values: Record<string, string>, opts: Partial<Parameters<typeof renderPdfOverlay>[3]> = {}) {
  return renderPdfOverlay(template, positions, values, { fontBytes, ...opts });
}

test("renderer: text tiếng Việt — Bùi Nguyễn Phương Vy", async () => {
  const tpl = await makeTemplate(1);
  const res = await render(tpl, [textPos()], { Ho_ten: "Bùi Nguyễn Phương Vy" });
  assert.equal(res.pageCount, 1);
  assert.equal(res.positionsDrawn, 1);
  assert.ok(res.bytes.byteLength > 0);
  assert.equal(res.sha256, sha256Hex(res.bytes));
});

test("renderer: single text đơn giản", async () => {
  const tpl = await makeTemplate(1);
  const res = await render(tpl, [textPos()], { Ho_ten: "Nguyễn Văn An" });
  assert.equal(res.positionsDrawn, 1);
});

test("renderer: multiline text (xuống dòng + wrap)", async () => {
  const tpl = await makeTemplate(1);
  const pos = textPos({ type: "MULTILINE_TEXT", multiline: true, width: 180, height: 60 });
  const res = await render(tpl, [pos], { Ho_ten: "Dòng một\nDòng hai dài hơn nhiều để wrap thành nhiều dòng" });
  assert.equal(res.positionsDrawn, 1);
});

test("renderer: địa chỉ dài wrap thành công (multiline)", async () => {
  const tpl = await makeTemplate(1);
  const pos = textPos({ placeholder: "Dia_chi_thuong_tru", type: "MULTILINE_TEXT", multiline: true, width: 180, height: 60 });
  const res = await render(tpl, [pos], {
    Dia_chi_thuong_tru: "Số 12, đường Trần Phú, phường 3, thành phố Đà Lạt, tỉnh Lâm Đồng, Việt Nam",
  });
  assert.equal(res.positionsDrawn, 1);
});

test("renderer: font shrinking — text dài tự thu nhỏ để vừa box", async () => {
  const tpl = await makeTemplate(1);
  const pos = textPos({ width: 90, fontSize: 14, minFontSize: 6 });
  const res = await render(tpl, [pos], { Ho_ten: "Nguyễn Văn Trường Sơn" });
  assert.equal(res.positionsDrawn, 1);
});

test("renderer: FIELD_OVERFLOW — không vừa ở minFontSize thì fail xác định", async () => {
  const tpl = await makeTemplate(1);
  // minFontSize không set → = fontSize → không shrink; width 30 quá hẹp cho chuỗi dài.
  const pos = textPos({ width: 30, fontSize: 10 });
  await assert.rejects(
    () => render(tpl, [pos], { Ho_ten: "Một câu rất dài để chắc chắn tràn ra ngoài ô" }),
    (err) => err instanceof PdfOverlayError && err.code === "FIELD_OVERFLOW",
  );
});

test("renderer: FIELD_OVERFLOW với ELLIPSIZE chỉ dành cho optional", async () => {
  const tpl = await makeTemplate(1);
  const pos = textPos({ width: 30, fontSize: 10, overflowPolicy: "ELLIPSIZE" });
  const res = await render(tpl, [pos], { Ho_ten: "Một câu rất dài để chắc chắn tràn ra ngoài ô" });
  assert.equal(res.positionsDrawn, 1); // bị cắt gọn, không throw
});

test("renderer: checkbox checked (☒) — vẽ mark vector, không throw", async () => {
  const tpl = await makeTemplate(1);
  const pos = textPos({ placeholder: "Tien_an_tien_su_Co", type: "CHECKBOX", width: 12, height: 12, checkboxStyle: "SQUARE_X" });
  const res = await render(tpl, [pos], { Tien_an_tien_su_Co: "☒" });
  assert.equal(res.positionsDrawn, 1);
});

test("renderer: checkbox unchecked (☐/rỗng) — vẫn vẽ ô trống", async () => {
  const tpl = await makeTemplate(1);
  const pos = textPos({ placeholder: "Tien_an_tien_su_Khong", type: "CHECKBOX", width: 12, height: 12 });
  const res1 = await render(tpl, [pos], { Tien_an_tien_su_Khong: "☐" });
  const res2 = await render(tpl, [pos], { Tien_an_tien_su_Khong: "" });
  assert.equal(res1.positionsDrawn, 1);
  assert.equal(res2.positionsDrawn, 1);
});

test("renderer: checkboxStateFromValue — quyết định vẽ xác định", () => {
  assert.equal(checkboxStateFromValue("☒"), true);
  assert.equal(checkboxStateFromValue("X"), true);
  assert.equal(checkboxStateFromValue("x"), true);
  assert.equal(checkboxStateFromValue("☐"), false);
  assert.equal(checkboxStateFromValue(""), false);
  assert.equal(checkboxStateFromValue(undefined), false);
  assert.equal(checkboxStateFromValue("false"), false);
});

test("renderer: cùng 1 placeholder nhiều position (page 1 + page 2) — cùng 1 giá trị", async () => {
  const tpl = await makeTemplate(2);
  const positions: PdfPositionSpec[] = [
    textPos({ pageNumber: 1, y: 700 }),
    textPos({ pageNumber: 1, y: 400 }),
    textPos({ pageNumber: 2, y: 700 }),
  ];
  const res = await render(tpl, positions, { Ho_ten: "Bùi Nguyễn Phương Vy" });
  assert.equal(res.pageCount, 2);
  assert.equal(res.positionsDrawn, 3);
});

test("renderer: nhiều trang — pageCount đúng, vẽ đúng trang", async () => {
  const tpl = await makeTemplate(3);
  const positions: PdfPositionSpec[] = [
    textPos({ pageNumber: 1 }),
    textPos({ pageNumber: 3, placeholder: "Email" }),
  ];
  const res = await render(tpl, positions, { Ho_ten: "An", Email: "a@b.c" });
  assert.equal(res.pageCount, 3);
  assert.equal(res.positionsDrawn, 2);
});

test("renderer: page number không hợp lệ → INVALID_PAGE_NUMBER", async () => {
  const tpl = await makeTemplate(2);
  await assert.rejects(
    () => render(tpl, [textPos({ pageNumber: 3 })], { Ho_ten: "An" }),
    (err) => err instanceof PdfOverlayError && err.code === "INVALID_PAGE_NUMBER",
  );
});

test("renderer: x âm ngoài trang → POSITION_OUT_OF_BOUNDS", async () => {
  const tpl = await makeTemplate(1);
  await assert.rejects(
    () => render(tpl, [textPos({ x: -5 })], { Ho_ten: "An" }),
    (err) => err instanceof PdfOverlayError && err.code === "POSITION_OUT_OF_BOUNDS",
  );
});

test("renderer: y vượt đỉnh trang → POSITION_OUT_OF_BOUNDS", async () => {
  const tpl = await makeTemplate(1);
  await assert.rejects(
    () => render(tpl, [textPos({ y: 840, height: 20 })], { Ho_ten: "An" }),
    (err) => err instanceof PdfOverlayError && err.code === "POSITION_OUT_OF_BOUNDS",
  );
});

test("renderer: bounding box vượt mép phải → POSITION_OUT_OF_BOUNDS", async () => {
  const tpl = await makeTemplate(1);
  await assert.rejects(
    () => render(tpl, [textPos({ x: 500, width: 200 })], { Ho_ten: "An" }),
    (err) => err instanceof PdfOverlayError && err.code === "POSITION_OUT_OF_BOUNDS",
  );
});

test("renderer: thiếu giá trị required → MISSING_REQUIRED_FIELD", async () => {
  const tpl = await makeTemplate(1);
  await assert.rejects(
    () => render(tpl, [textPos({ isRequired: true })], { Ho_ten: "" }),
    (err) => err instanceof PdfOverlayError && err.code === "MISSING_REQUIRED_FIELD",
  );
});

test("renderer: optional rỗng → bỏ qua (không vẽ, không lỗi)", async () => {
  const tpl = await makeTemplate(1);
  const res = await render(tpl, [textPos()], { Ho_ten: "" });
  assert.equal(res.positionsDrawn, 0);
});

test("renderer: thiếu fontBytes → FONT_BYTES_REQUIRED (không dùng Standard-14)", async () => {
  const tpl = await makeTemplate(1);
  await assert.rejects(
    () => renderPdfOverlay(tpl, [textPos()], { Ho_ten: "An" }, { fontBytes: new Uint8Array(0) }),
    (err) => err instanceof PdfOverlayError && err.code === "FONT_BYTES_REQUIRED",
  );
});

test("renderer: expectedPageCount khác thật → TEMPLATE_PAGE_COUNT_MISMATCH", async () => {
  const tpl = await makeTemplate(2);
  await assert.rejects(
    () => render(tpl, [textPos()], { Ho_ten: "An" }, { expectedPageCount: 5 }),
    (err) => err instanceof PdfOverlayError && err.code === "TEMPLATE_PAGE_COUNT_MISMATCH",
  );
});

test("renderer: STATIC_TEXT vẽ từ staticText, không cần fieldValues", async () => {
  const tpl = await makeTemplate(1);
  const pos = textPos({ type: "STATIC_TEXT", staticText: "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", width: 300 });
  const res = await render(tpl, [pos], {});
  assert.equal(res.positionsDrawn, 1);
});

test("renderer: whiteout vẽ hình chữ nhật trắng trước khi vẽ (không throw)", async () => {
  const tpl = await makeTemplate(1);
  const res = await render(tpl, [textPos({ whiteout: true })], { Ho_ten: "An" });
  assert.equal(res.positionsDrawn, 1);
});

test("renderer: output xác định — cùng input → cùng sha256", async () => {
  const tpl = await makeTemplate(1);
  const positions = [textPos(), textPos({ placeholder: "Tien_an_tien_su_Co", type: "CHECKBOX", width: 12, height: 12, y: 600 })];
  const values = { Ho_ten: "Bùi Nguyễn Phương Vy", Tien_an_tien_su_Co: "☒" };
  const a = await render(tpl, positions, values);
  const b = await render(tpl, positions, values);
  assert.equal(a.sha256, b.sha256);
  assert.deepEqual(a.bytes, b.bytes);
});

test("renderer: input khác → sha256 khác", async () => {
  const tpl = await makeTemplate(1);
  const a = await render(tpl, [textPos()], { Ho_ten: "Nguyễn Văn An" });
  const b = await render(tpl, [textPos()], { Ho_ten: "Bùi Nguyễn Phương Vy" });
  assert.notEqual(a.sha256, b.sha256);
});

test("renderer: source record (fieldValues) không bị đột biến", async () => {
  const tpl = await makeTemplate(1);
  const fieldValues: Record<string, string> = { Ho_ten: "Bùi Nguyễn Phương Vy" };
  const snapshot = JSON.stringify(fieldValues);
  Object.freeze(fieldValues);
  await render(tpl, [textPos()], fieldValues);
  assert.equal(JSON.stringify(fieldValues), snapshot);
});
