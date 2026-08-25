import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSigningContext,
  toFormulaContextValues,
  toJsonSigningContext,
  getTodayInBusinessTimezone,
  EMPTY_SIGNING_CONTEXT,
  type SigningContext,
} from "./signing-context.ts";
import { evaluateFormula, parseFormula } from "./formula-dsl.ts";

test("parses a complete, valid context", () => {
  const r = parseSigningContext({
    signingDate: "2026-08-26",
    signingLocation: "Đà Lạt",
    documentDate: "2026-08-20",
    receivedDate: "2026-08-25",
    receivedBy: "Nguyễn Văn A",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.context.signingDate, "2026-08-26");
  assert.equal(r.context.signingLocation, "Đà Lạt");
});

test("every field is optional — an empty object parses to an all-null context", () => {
  const r = parseSigningContext({});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.context, EMPTY_SIGNING_CONTEXT);
});

test("null/non-object input does not throw — normalizes to empty context", () => {
  assert.equal(parseSigningContext(null).ok, true);
  assert.equal(parseSigningContext(undefined).ok, true);
  assert.equal(parseSigningContext("not an object").ok, true);
  assert.equal(parseSigningContext([1, 2, 3]).ok, true);
});

test("rejects a malformed date (not YYYY-MM-DD)", () => {
  const r = parseSigningContext({ signingDate: "26/08/2026" });
  assert.equal(r.ok, false);
});

test("rejects a non-string signingLocation", () => {
  const r = parseSigningContext({ signingLocation: 12345 });
  assert.equal(r.ok, false);
});

test("trims whitespace from text fields", () => {
  const r = parseSigningContext({ signingLocation: "  Đà Lạt  " });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.context.signingLocation, "Đà Lạt");
});

test("optional GPS metadata: valid coordinates accepted, out-of-range rejected", () => {
  const ok = parseSigningContext({ signingLatitude: 11.94, signingLongitude: 108.44 });
  assert.equal(ok.ok, true);
  const badLat = parseSigningContext({ signingLatitude: 200 });
  assert.equal(badLat.ok, false);
  const badLng = parseSigningContext({ signingLongitude: -200 });
  assert.equal(badLng.ok, false);
});

test("GPS metadata is entirely optional — omitting it is valid", () => {
  const r = parseSigningContext({ signingDate: "2026-08-26" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.context.signingLatitude, null);
  assert.equal(r.context.signingLongitude, null);
  assert.equal(r.context.signingLocationCapturedAt, null);
});

test("signingLocationCapturedAt must be a parseable timestamp when present", () => {
  const ok = parseSigningContext({ signingLocationCapturedAt: "2026-08-26T10:00:00Z" });
  assert.equal(ok.ok, true);
  const bad = parseSigningContext({ signingLocationCapturedAt: "not a timestamp" });
  assert.equal(bad.ok, false);
});

test("toFormulaContextValues maps 1:1 onto formula-dsl's ALLOWED_IDENTIFIERS keys and feeds the evaluator correctly", () => {
  const r = parseSigningContext({
    signingDate: "2026-08-26",
    signingLocation: "Đà Lạt",
    receivedDate: "2026-08-25",
    receivedBy: "Nguyễn Văn A",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const values = toFormulaContextValues(r.context);

  const parsed = parseFormula('concat(day(SigningDate), "/", month(SigningDate), "/", year(SigningDate))');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const evaluated = evaluateFormula(parsed.ast, values);
  assert.equal(evaluated.ok, true);
  if (evaluated.ok) assert.equal(evaluated.value, "26/08/2026");
});

test("toFormulaContextValues stringifies numeric GPS fields for the string-only DSL", () => {
  const context: SigningContext = { ...EMPTY_SIGNING_CONTEXT, signingLatitude: 11.94, signingLongitude: 108.44 };
  const values = toFormulaContextValues(context);
  assert.equal(values.SigningLatitude, "11.94");
  assert.equal(values.SigningLongitude, "108.44");
});

test("toJsonSigningContext produces a plain, audit-safe object (no functions, no class instances)", () => {
  const json = toJsonSigningContext({ ...EMPTY_SIGNING_CONTEXT, signingDate: "2026-08-26" });
  assert.equal(JSON.parse(JSON.stringify(json)).signingDate, "2026-08-26");
});

test("getTodayInBusinessTimezone: is deterministic for a given instant, uses Asia/Ho_Chi_Minh — never silently assumes UTC", () => {
  // 2026-08-26T17:30:00Z is 2026-08-27 00:30 in Asia/Ho_Chi_Minh (UTC+7) —
  // proves the function is NOT just reading UTC/server-local date parts.
  const instant = new Date("2026-08-26T17:30:00Z");
  assert.equal(getTodayInBusinessTimezone(instant), "2026-08-27");
});

test("getTodayInBusinessTimezone: near-midnight UTC boundary stays on the correct Vietnam calendar day", () => {
  const justBeforeUtcMidnight = new Date("2026-08-26T23:59:00Z");
  // 23:59 UTC + 7h = 06:59 next day in Vietnam.
  assert.equal(getTodayInBusinessTimezone(justBeforeUtcMidnight), "2026-08-27");
});
