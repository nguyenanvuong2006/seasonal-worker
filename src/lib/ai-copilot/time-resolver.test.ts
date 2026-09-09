import test from "node:test";
import assert from "node:assert/strict";
import { resolveTimeExpression, samePeriodLastYear, weekRange, monthRange, quarterRange, yearRange } from "./time-resolver.ts";

const TODAY = "2026-09-09"; // Wednesday

test("today / yesterday", () => {
  assert.deepEqual(resolveTimeExpression({ period: "today" }, TODAY), { ok: true, period: { from: "2026-09-09", to: "2026-09-09", label: "Hôm nay" }, comparisonPeriod: null });
  assert.deepEqual(resolveTimeExpression({ period: "yesterday" }, TODAY), { ok: true, period: { from: "2026-09-08", to: "2026-09-08", label: "Hôm qua" }, comparisonPeriod: null });
});

test("this_week / last_week — Vietnamese week starts Monday", () => {
  const r1 = resolveTimeExpression({ period: "this_week" }, TODAY);
  assert.deepEqual(r1, { ok: true, period: { from: "2026-09-07", to: "2026-09-13", label: "Tuần này" }, comparisonPeriod: null });
  const r2 = resolveTimeExpression({ period: "last_week" }, TODAY);
  assert.deepEqual(r2, { ok: true, period: { from: "2026-08-31", to: "2026-09-06", label: "Tuần trước" }, comparisonPeriod: null });
});

test("this_month / last_month — correctly crosses a month boundary with 31/30-day months", () => {
  const r1 = resolveTimeExpression({ period: "this_month" }, TODAY);
  assert.deepEqual(r1, { ok: true, period: { from: "2026-09-01", to: "2026-09-30", label: "Tháng này" }, comparisonPeriod: null });
  const r2 = resolveTimeExpression({ period: "last_month" }, TODAY);
  assert.deepEqual(r2, { ok: true, period: { from: "2026-08-01", to: "2026-08-31", label: "Tháng trước" }, comparisonPeriod: null });
});

test("this_quarter / last_quarter", () => {
  const r1 = resolveTimeExpression({ period: "this_quarter" }, TODAY);
  assert.deepEqual(r1, { ok: true, period: { from: "2026-07-01", to: "2026-09-30", label: "Quý này" }, comparisonPeriod: null });
  const r2 = resolveTimeExpression({ period: "last_quarter" }, TODAY);
  assert.deepEqual(r2, { ok: true, period: { from: "2026-04-01", to: "2026-06-30", label: "Quý trước" }, comparisonPeriod: null });
});

test("this_year / last_year", () => {
  const r1 = resolveTimeExpression({ period: "this_year" }, TODAY);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.ok && r1.period, { from: "2026-01-01", to: "2026-12-31", label: "Năm nay" });
  const r2 = resolveTimeExpression({ period: "last_year" }, TODAY);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.ok && r2.period, { from: "2025-01-01", to: "2025-12-31", label: "Năm trước" });
});

test("last_7_days / last_30_days / last_90_days — always INCLUDE today as the end date", () => {
  const r7 = resolveTimeExpression({ period: "last_7_days" }, TODAY);
  assert.deepEqual(r7, { ok: true, period: { from: "2026-09-03", to: "2026-09-09", label: "7 ngày qua" }, comparisonPeriod: null });
  const r30 = resolveTimeExpression({ period: "last_30_days" }, TODAY);
  assert.deepEqual(r30, { ok: true, period: { from: "2026-08-11", to: "2026-09-09", label: "30 ngày qua" }, comparisonPeriod: null });
  const r90 = resolveTimeExpression({ period: "last_90_days" }, TODAY);
  assert.deepEqual(r90, { ok: true, period: { from: "2026-06-12", to: "2026-09-09", label: "90 ngày qua" }, comparisonPeriod: null });
});

test("explicit year: \"năm 2025\"", () => {
  const r = resolveTimeExpression({ year: 2025 }, TODAY);
  assert.deepEqual(r, { ok: true, period: { from: "2025-01-01", to: "2025-12-31", label: "Năm 2025" }, comparisonPeriod: null });
});

test("explicit year rejects out-of-range values", () => {
  assert.equal(resolveTimeExpression({ year: 1899 }, TODAY).ok, false);
  assert.equal(resolveTimeExpression({ year: 2101 }, TODAY).ok, false);
  assert.equal(resolveTimeExpression({ year: 2025.5 }, TODAY).ok, false);
});

test("explicit from/to range", () => {
  const r = resolveTimeExpression({ from: "2026-01-15", to: "2026-02-15" }, TODAY);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.period, { from: "2026-01-15", to: "2026-02-15", label: "2026-01-15 → 2026-02-15" });
});

test("explicit range rejects to < from, and rejects a lone from or to without the other", () => {
  assert.equal(resolveTimeExpression({ from: "2026-02-15", to: "2026-01-15" }, TODAY).ok, false);
  assert.equal(resolveTimeExpression({ from: "2026-01-15" }, TODAY).ok, false);
  assert.equal(resolveTimeExpression({ to: "2026-01-15" }, TODAY).ok, false);
});

test("invalid period keyword is rejected, never silently guessed", () => {
  const r = resolveTimeExpression({ period: "next_decade" }, TODAY);
  assert.equal(r.ok, false);
});

test("defaults to this_month when nothing is specified — matches the mission's 'hiện tại mặc định NGAY BÂY GIỜ' semantics for a monthly-shaped question", () => {
  const r = resolveTimeExpression({}, TODAY);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.period, { from: "2026-09-01", to: "2026-09-30", label: "Tháng này" });
});

test("cùng kỳ năm trước (compareToSamePeriodLastYear) attaches a comparisonPeriod exactly one calendar year earlier", () => {
  const r = resolveTimeExpression({ period: "this_month", compareToSamePeriodLastYear: true }, TODAY);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.comparisonPeriod?.from, "2025-09-01");
  assert.equal(r.ok && r.comparisonPeriod?.to, "2025-09-30");
});

test("samePeriodLastYear clamps Feb 29 (leap) to Feb 28 in a non-leap target year", () => {
  assert.deepEqual(samePeriodLastYear("2028-02-29", "2028-02-29"), { from: "2027-02-28", to: "2027-02-28" });
});

test("samePeriodLastYear on an ordinary date is a plain year decrement", () => {
  assert.deepEqual(samePeriodLastYear("2026-09-09", "2026-09-09"), { from: "2025-09-09", to: "2025-09-09" });
});

test("weekRange/monthRange/quarterRange/yearRange are pure and directly usable outside resolveTimeExpression", () => {
  assert.deepEqual(weekRange("2026-09-09"), { from: "2026-09-07", to: "2026-09-13" });
  assert.deepEqual(monthRange("2026-09-09"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(quarterRange("2026-09-09"), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(yearRange(2026), { from: "2026-01-01", to: "2026-12-31" });
});

test("an invalid `today` anchor is rejected rather than silently producing wrong dates", () => {
  const r = resolveTimeExpression({ period: "today" }, "not-a-date");
  assert.equal(r.ok, false);
});
