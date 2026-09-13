import test from "node:test";
import assert from "node:assert/strict";
import { todayStr } from "./helpers.ts";
import {
  addDaysToDateStr,
  buildDateRangePreset,
  daysBetweenDates,
  DEFAULT_MAX_RANGE_DAYS,
  formatDateRangeLabel,
  isValidBusinessDate,
  parseOperationalDateRange,
  rangeFilenameSuffix,
  vnDateRangeToTimestampBounds,
  vnStartOfDayUtc,
} from "./date-range.ts";

/* ============================================================
   KIỂM THỬ src/lib/date-range.ts — CONTRACT DUY NHẤT cho mọi
   OPERATIONAL_DATE_FILTER trong hệ thống (GLOBAL DATE RANGE
   STANDARDIZATION). Mã test D1-D7 khớp mission test matrix.
   ============================================================ */

function qs(params: Record<string, string>) {
  return new URLSearchParams(params);
}

// D1 — mặc định (không có tham số nào) = hôm nay/hôm nay (Asia/Ho_Chi_Minh).
test("D1: no params -> defaults to today/today", () => {
  const result = parseOperationalDateRange(qs({}));
  assert.ok(result.ok);
  if (!result.ok) return;
  const today = todayStr();
  assert.equal(result.range.from, today);
  assert.equal(result.range.to, today);
});

// D2 — legacy `date=` vẫn được hỗ trợ mãi mãi: from=to=date.
test("D2: legacy date= param -> from=to=date", () => {
  const result = parseOperationalDateRange(qs({ date: "2026-09-01" }));
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.range, { from: "2026-09-01", to: "2026-09-01" });
});

test("D2b: from/to present together with legacy date= -> from/to wins", () => {
  const result = parseOperationalDateRange(qs({ date: "2026-01-01", from: "2026-09-01", to: "2026-09-05" }));
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.range, { from: "2026-09-01", to: "2026-09-05" });
});

test("D2c: only from= given (no to=) -> to defaults to from", () => {
  const result = parseOperationalDateRange(qs({ from: "2026-09-03" }));
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.range, { from: "2026-09-03", to: "2026-09-03" });
});

test("D2d: only to= given (no from=) -> from defaults to to", () => {
  const result = parseOperationalDateRange(qs({ to: "2026-09-03" }));
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.range, { from: "2026-09-03", to: "2026-09-03" });
});

// D3 — khoảng ngày hợp lệ (from <= to) -> trả về đúng khoảng đó.
test("D3: valid multi-day range -> returned as-is", () => {
  const result = parseOperationalDateRange(qs({ from: "2026-09-01", to: "2026-09-13" }));
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.range, { from: "2026-09-01", to: "2026-09-13" });
});

// D4 — from > to -> INVALID_DATE_RANGE.
test("D4: from > to -> INVALID_DATE_RANGE, Vietnamese message", () => {
  const result = parseOperationalDateRange(qs({ from: "2026-09-13", to: "2026-09-01" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_DATE_RANGE");
  assert.equal(result.error.message, "Từ ngày không được lớn hơn Đến ngày.");
});

// D5 — ngày không hợp lệ (sai định dạng hoặc ngày không tồn tại) -> INVALID_DATE_RANGE, không phải lỗi DB thô.
test("D5: malformed date string -> INVALID_DATE_RANGE", () => {
  const result = parseOperationalDateRange(qs({ date: "not-a-date" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_DATE_RANGE");
});

test("D5b: calendar-impossible date (2026-02-30) -> INVALID_DATE_RANGE, not silently rolled over", () => {
  const result = parseOperationalDateRange(qs({ date: "2026-02-30" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_DATE_RANGE");
});

test("D5c: month 13 -> INVALID_DATE_RANGE", () => {
  const result = parseOperationalDateRange(qs({ from: "2026-13-01", to: "2026-13-01" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_DATE_RANGE");
});

// D6 — ranh giới múi giờ VN: "hôm nay" phải theo Asia/Ho_Chi_Minh, không phải UTC.
// Môi trường chạy test là UTC (xác nhận qua process — xem README môi trường); 17:30 UTC
// = 00:30 ngày hôm sau giờ VN (UTC+7) — buildDateRangePreset("TODAY") tại thời điểm đó
// phải trả về ngày VN (hôm sau UTC-day), không phải ngày UTC hiện tại.
test("D6: VN timezone boundary — 17:30 UTC is already the next VN calendar day", () => {
  const utcInstant = new Date(Date.UTC(2026, 8, 12, 17, 30, 0)); // 2026-09-12 17:30 UTC = 2026-09-13 00:30 ICT
  const range = buildDateRangePreset("TODAY", utcInstant);
  assert.deepEqual(range, { from: "2026-09-13", to: "2026-09-13" }, "must resolve to the VN calendar day, not the UTC calendar day");
});

test("D6b: 16:30 UTC is still the same VN calendar day (23:30 ICT)", () => {
  const utcInstant = new Date(Date.UTC(2026, 8, 12, 16, 30, 0)); // 2026-09-12 16:30 UTC = 2026-09-12 23:30 ICT
  const range = buildDateRangePreset("TODAY", utcInstant);
  assert.deepEqual(range, { from: "2026-09-12", to: "2026-09-12" });
});

// D7 — cột TIMESTAMP dùng khoảng nửa mở [from 00:00 VN, ngày-sau-to 00:00 VN).
test("D7: timestamp half-open bounds — end is exclusive at the day AFTER `to`, VN midnight", () => {
  const bounds = vnDateRangeToTimestampBounds({ from: "2026-09-01", to: "2026-09-13" });
  assert.deepEqual(bounds.startUtc, vnStartOfDayUtc("2026-09-01"));
  assert.deepEqual(bounds.endUtcExclusive, vnStartOfDayUtc("2026-09-14"), "exclusive end must be the VN midnight of the day AFTER `to`, not `to` itself");
});

test("D7b: an instant at 23:59:59.999 ICT on `to` falls INSIDE the half-open interval", () => {
  const bounds = vnDateRangeToTimestampBounds({ from: "2026-09-01", to: "2026-09-13" });
  const lastInstantOfToVn = new Date(bounds.endUtcExclusive.getTime() - 1);
  assert.ok(lastInstantOfToVn >= bounds.startUtc && lastInstantOfToVn < bounds.endUtcExclusive);
});

test("D7c: the exact exclusive-end instant itself is NOT included", () => {
  const bounds = vnDateRangeToTimestampBounds({ from: "2026-09-01", to: "2026-09-13" });
  assert.ok(!(bounds.endUtcExclusive < bounds.endUtcExclusive), "sanity: endUtcExclusive must never satisfy `< endUtcExclusive`");
});

/* ------------------------------------------------------------
   Range-limit guardrail (mission section 25) — default max 366 days,
   never an arbitrary 7/30-day cap; exceeding it is a structured error.
   ------------------------------------------------------------ */
test("DEFAULT_MAX_RANGE_DAYS is 366, not an arbitrary short cap", () => {
  assert.equal(DEFAULT_MAX_RANGE_DAYS, 366);
});

test("exactly 366 days (inclusive) is allowed", () => {
  const from = "2026-01-01";
  const to = addDaysToDateStr(from, 365); // 366 inclusive days
  const result = parseOperationalDateRange(qs({ from, to }));
  assert.ok(result.ok);
});

test("367 days -> DATE_RANGE_TOO_LARGE, not a raw DB error", () => {
  const from = "2026-01-01";
  const to = addDaysToDateStr(from, 366); // 367 inclusive days
  const result = parseOperationalDateRange(qs({ from, to }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "DATE_RANGE_TOO_LARGE");
});

test("custom maxRangeDays option is honored", () => {
  const result = parseOperationalDateRange(qs({ from: "2026-09-01", to: "2026-09-10" }), { maxRangeDays: 5 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "DATE_RANGE_TOO_LARGE");
});

/* ------------------------------------------------------------
   Pure helper functions.
   ------------------------------------------------------------ */
test("isValidBusinessDate: accepts real calendar dates", () => {
  assert.equal(isValidBusinessDate("2026-09-13"), true);
  assert.equal(isValidBusinessDate("2024-02-29"), true, "2024 is a leap year");
});

test("isValidBusinessDate: rejects non-existent calendar dates and bad formats", () => {
  assert.equal(isValidBusinessDate("2026-02-30"), false);
  assert.equal(isValidBusinessDate("2025-02-29"), false, "2025 is not a leap year");
  assert.equal(isValidBusinessDate("2026-13-01"), false);
  assert.equal(isValidBusinessDate("2026-9-1"), false, "must be zero-padded YYYY-MM-DD");
  assert.equal(isValidBusinessDate("not-a-date"), false);
  assert.equal(isValidBusinessDate(""), false);
});

test("daysBetweenDates: pure calendar-day arithmetic", () => {
  assert.equal(daysBetweenDates("2026-09-01", "2026-09-01"), 0);
  assert.equal(daysBetweenDates("2026-09-01", "2026-09-13"), 12);
  assert.equal(daysBetweenDates("2026-08-31", "2026-09-01"), 1, "must cross month boundary correctly");
});

test("addDaysToDateStr: forward and backward, crossing month/year boundaries", () => {
  assert.equal(addDaysToDateStr("2026-09-01", 12), "2026-09-13");
  assert.equal(addDaysToDateStr("2026-09-13", -12), "2026-09-01");
  assert.equal(addDaysToDateStr("2026-08-31", 1), "2026-09-01");
  assert.equal(addDaysToDateStr("2026-12-31", 1), "2027-01-01");
});

test("formatDateRangeLabel: single day vs multi-day wording", () => {
  const fmt = (v: string) => v.split("-").reverse().join("/");
  assert.equal(formatDateRangeLabel({ from: "2026-09-13", to: "2026-09-13" }, fmt), "NGÀY 13/09/2026");
  assert.equal(formatDateRangeLabel({ from: "2026-09-01", to: "2026-09-13" }, fmt), "TỪ 01/09/2026 ĐẾN 13/09/2026");
});

test("rangeFilenameSuffix: single day vs range", () => {
  assert.equal(rangeFilenameSuffix({ from: "2026-09-13", to: "2026-09-13" }), "2026-09-13");
  assert.equal(rangeFilenameSuffix({ from: "2026-09-01", to: "2026-09-13" }), "2026-09-01_2026-09-13");
});

test("buildDateRangePreset: LAST_7_DAYS is today-6..today (7 days inclusive)", () => {
  const now = new Date(Date.UTC(2026, 8, 13, 3, 0, 0)); // well inside VN 2026-09-13
  const range = buildDateRangePreset("LAST_7_DAYS", now);
  assert.deepEqual(range, { from: "2026-09-07", to: "2026-09-13" });
  assert.equal(daysBetweenDates(range.from, range.to) + 1, 7);
});

test("buildDateRangePreset: THIS_MONTH is first-of-month..today", () => {
  const now = new Date(Date.UTC(2026, 8, 13, 3, 0, 0));
  const range = buildDateRangePreset("THIS_MONTH", now);
  assert.deepEqual(range, { from: "2026-09-01", to: "2026-09-13" });
});
