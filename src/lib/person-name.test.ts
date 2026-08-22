import test from "node:test";
import assert from "node:assert/strict";
import { normalizePersonName } from "./person-name.ts";

test("Viết thường toàn bộ -> viết hoa chữ cái đầu mỗi từ", () => {
  assert.equal(normalizePersonName("nguyen van tri"), "Nguyen Van Tri");
});

test("Viết hoa toàn bộ -> viết hoa chữ cái đầu mỗi từ", () => {
  assert.equal(normalizePersonName("NGUYEN VAN TRI"), "Nguyen Van Tri");
});

test("Hoa/thường lẫn lộn -> viết hoa chữ cái đầu mỗi từ", () => {
  assert.equal(normalizePersonName("NGUYEN Van TRi"), "Nguyen Van Tri");
});

test("Tên tiếng Việt có dấu và chữ Đ — không làm mất dấu", () => {
  assert.equal(normalizePersonName("đẶNG tHỊ tHÚY nGA"), "Đặng Thị Thúy Nga");
});

test("Khoảng trắng thừa đầu/cuối/giữa được gộp", () => {
  assert.equal(normalizePersonName("  nguyen    van   tri  "), "Nguyen Van Tri");
});

test("Tên có gạch nối — viết hoa sau gạch nối", () => {
  assert.equal(normalizePersonName("nguyễn thị thu-hà"), "Nguyễn Thị Thu-Hà");
  assert.equal(normalizePersonName("NGUYỄN-VĂN-TRI"), "Nguyễn-Văn-Tri");
});

test("Tên có dấu nháy — viết hoa sau dấu nháy", () => {
  assert.equal(normalizePersonName("d'artagnan"), "D'Artagnan");
  assert.equal(normalizePersonName("o’neil"), "O’Neil");
});

test("Tên có dấu câu (dấu chấm tên viết tắt)", () => {
  assert.equal(normalizePersonName("trần t. minh"), "Trần T. Minh");
});

test("Giá trị rỗng/null/không phải chuỗi", () => {
  assert.equal(normalizePersonName(""), "");
  assert.equal(normalizePersonName("   "), "");
  assert.equal(normalizePersonName(null), "");
  assert.equal(normalizePersonName(undefined), "");
  assert.equal(normalizePersonName(123 as unknown), "");
});

test("Chuỗi đã chuẩn hoá giữ nguyên (idempotent)", () => {
  assert.equal(normalizePersonName("Nguyễn Văn Tri"), "Nguyễn Văn Tri");
  assert.equal(normalizePersonName("Đặng Thị Thúy Nga"), "Đặng Thị Thúy Nga");
});

test("NFD (dau to hop roi, nhin giong het NFC nhung khac byte) chuan hoa ve CUNG ket qua voi NFC", () => {
  const nfcName = "Nguyễn Văn An"; // dạng NFC bình thường (gõ từ bàn phím/browser)
  const nfdName = nfcName.normalize("NFD"); // CÙNG văn bản, dấu tổ hợp tách rời
  assert.notEqual(nfdName, nfcName, "tiền đề: 2 chuỗi phải khác byte dù nhìn giống hệt");
  assert.equal(normalizePersonName(nfdName), normalizePersonName(nfcName));
  assert.equal(normalizePersonName(nfdName), "Nguyễn Văn An");
});
