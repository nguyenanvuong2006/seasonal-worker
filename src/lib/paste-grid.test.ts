import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGridHeader, parseClipboardTable, resolvePasteTargetIds, serializeCsv } from "./paste-grid.ts";

test("parseClipboardTable reads Excel/Google Sheets tab-separated cells", () => {
  assert.deepEqual(parseClipboardTable("A\tB\n1\t2\n3\t4\n"), [
    ["A", "B"],
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("parseClipboardTable preserves quoted tabs, quotes, and newlines", () => {
  assert.deepEqual(parseClipboardTable('"Họ\tvà tên"\tGhi chú\n"Nguyễn ""An"""\t"Dòng 1\nDòng 2"'), [
    ["Họ\tvà tên", "Ghi chú"],
    ['Nguyễn "An"', "Dòng 1\nDòng 2"],
  ]);
});

test("single-column paste stays in one column", () => {
  assert.deepEqual(parseClipboardTable("Nguyễn Văn A\nTrần Thị B"), [["Nguyễn Văn A"], ["Trần Thị B"]]);
});

test("serializeCsv escapes Vietnamese text, commas, quotes, and newlines", () => {
  assert.equal(
    serializeCsv(["Họ tên", "Ghi chú"], [["Nguyễn, An", 'Có "kinh nghiệm"\n2 năm']]),
    '\uFEFF"Họ tên","Ghi chú"\r\n"Nguyễn, An","Có ""kinh nghiệm""\n2 năm"\r\n',
  );
});

test("normalizeGridHeader matches Vietnamese headers without accents", () => {
  assert.equal(normalizeGridHeader("  Số CCCD  "), "socccd");
  assert.equal(normalizeGridHeader("Địa chỉ hiện tại"), "diachihientai");
});

test("paste có header giữ vị trí nhưng bỏ qua cột đã ẩn", () => {
  assert.deepEqual(resolvePasteTargetIds({
    copiedColumnCount: 3,
    hasHeader: true,
    matchedIds: ["name", "deleted-phone", "address"],
    visibleIds: ["name", "address"],
    startColumn: 0,
  }), {
    targetIds: ["name", null, "address"],
    error: null,
  });
});

test("paste không header bị chặn khi rộng hơn phần bảng còn lại", () => {
  const result = resolvePasteTargetIds({
    copiedColumnCount: 3,
    hasHeader: false,
    matchedIds: [],
    visibleIds: ["name", "phone"],
    startColumn: 0,
  });
  assert.deepEqual(result.targetIds, []);
  assert.match(result.error ?? "", /Vùng copy có 3 cột nhưng bảng chỉ còn 2 cột/);
});
