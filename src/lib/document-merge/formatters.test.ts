import test from "node:test";
import assert from "node:assert/strict";
import { formatValue, isValidFormatType, getAvailableFormatTypes } from "./formatters.ts";

test("formatValue: null/undefined -> fallback nếu có, ngược lại chuỗi rỗng", () => {
  assert.equal(formatValue(null, "RAW"), "");
  assert.equal(formatValue(undefined, "RAW"), "");
  assert.equal(formatValue(null, "RAW", "N/A"), "N/A");
});

test("formatValue DATE_DDMMYYYY: ngày-thuần (không time-of-day) hiển thị đúng ngày, không lệch theo timezone server", () => {
  // regDate/startingDate/dob dạng "date" Postgres — parse ra UTC-midnight —
  // không có time-of-day nên không thể bị lệch ngày dù đọc theo timezone nào.
  assert.equal(formatValue("2001-03-15", "DATE_DDMMYYYY"), "15/03/2001");
});

test("formatValue DATE_DDMMYYYY_HHMM: phút PHẢI được thay đúng giá trị thật (regression — trước đây luôn để lại literal \"mm\")", () => {
  // 10:05 UTC — chọn giờ giữa ngày để tránh chồng lấn với bài test lệch-ngày
  // dưới đây; mục tiêu riêng của test này là: phút (05) phải xuất hiện trong
  // kết quả, không phải chuỗi "mm" chưa được thay.
  const result = formatValue("2026-03-15T10:05:00Z", "DATE_DDMMYYYY_HHMM");
  assert.doesNotMatch(result, /mm/, "phút không được để lại literal 'mm' chưa thay");
  assert.match(result, /:05$/, "phút (05) phải xuất hiện đúng ở cuối chuỗi HH:mm");
});

test("formatValue DATE_DDMMYYYY_HHMM: timestamp buổi tối UTC hiển thị ĐÚNG ngày giờ Việt Nam (Asia/Ho_Chi_Minh, UTC+7), không lệch theo giờ server", () => {
  // 22:00 UTC ngày 21/08 = 05:00 sáng 22/08 giờ Việt Nam (+7). Trước khi sửa,
  // formatDate() đọc Date.getDate()/getHours() theo timezone TIẾN TRÌNH
  // server (Vercel mặc định UTC) — sẽ in "21/08/2026 22:00" (SAI, lùi 1 ngày
  // so với ngày thật người Việt Nam nhìn thấy). Kết quả đúng phải là ngày 22.
  const result = formatValue("2026-08-21T22:00:00Z", "DATE_DDMMYYYY_HHMM");
  assert.equal(result, "22/08/2026 05:00");
});

test("formatValue DATE_DDMMYYYY: timestamp gần nửa đêm UTC vẫn lệch sang ngày hôm sau theo giờ Việt Nam", () => {
  // 17:30 UTC = 00:30 sáng hôm sau giờ Việt Nam — biên giới sớm nhất trong
  // ngày UTC mà ngày Việt Nam đã sang ngày mới.
  assert.equal(formatValue("2026-08-21T17:30:00Z", "DATE_DDMMYYYY"), "22/08/2026");
});

test("formatValue DATE_DD_MM_YYYY: dùng dấu gạch ngang, không bị token DD/MM/YYYY 'ăn' nhầm nhau", () => {
  assert.equal(formatValue("2026-01-05T00:00:00Z", "DATE_DD_MM_YYYY"), "05-01-2026");
});

test("formatValue: chuỗi ngày không hợp lệ -> fallback hoặc rỗng, không throw", () => {
  assert.equal(formatValue("không phải ngày", "DATE_DDMMYYYY"), "");
  assert.equal(formatValue("không phải ngày", "DATE_DDMMYYYY", "N/A"), "N/A");
});

test("formatValue UPPERCASE/LOWERCASE/TITLE_CASE", () => {
  assert.equal(formatValue("Nguyễn Văn A", "UPPERCASE"), "NGUYỄN VĂN A");
  assert.equal(formatValue("Nguyễn Văn A", "LOWERCASE"), "nguyễn văn a");
  assert.equal(formatValue("nguyễn văn a", "TITLE_CASE"), "Nguyễn Văn A");
});

test("formatValue NUMBER: định dạng phân cách hàng nghìn", () => {
  assert.equal(formatValue("1500000", "NUMBER"), "1.500.000");
});

test("formatValue CURRENCY_VND: hậu tố 'đồng'", () => {
  assert.equal(formatValue("1500000", "CURRENCY_VND"), "1.500.000 đồng");
});

test("formatValue BOOLEAN_CHECKBOX: nhận diện các giá trị true kiểu Việt Nam", () => {
  assert.equal(formatValue("co", "BOOLEAN_CHECKBOX"), "☒");
  assert.equal(formatValue(true, "BOOLEAN_CHECKBOX"), "☒");
  assert.equal(formatValue("khong", "BOOLEAN_CHECKBOX"), "☐");
  // null/undefined được formatValue() chặn TRƯỚC switch (dùng chung cho mọi
  // formatType) — trả fallbackValue nếu có, ngược lại rỗng; nhánh
  // formatBooleanAsCheckbox()'s own null-handling không bao giờ được chạm tới.
  assert.equal(formatValue(null, "BOOLEAN_CHECKBOX"), "");
  assert.equal(formatValue(null, "BOOLEAN_CHECKBOX", "☐"), "☐");
});

test("formatValue RAW: trả nguyên chuỗi", () => {
  assert.equal(formatValue(42, "RAW"), "42");
});

test("isValidFormatType / getAvailableFormatTypes: nhất quán với nhau", () => {
  for (const { value } of getAvailableFormatTypes()) {
    assert.equal(isValidFormatType(value), true);
  }
  assert.equal(isValidFormatType("KHONG_TON_TAI"), false);
});
