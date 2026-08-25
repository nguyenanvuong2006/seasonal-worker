import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFormula,
  evaluateFormula,
  resolveFormula,
  MAX_EXPRESSION_LENGTH,
  MAX_AST_DEPTH,
  MAX_ARGUMENTS,
  MAX_FUNCTION_CALLS,
  MAX_OUTPUT_LENGTH,
  type FormulaContextValues,
} from "./formula-dsl.ts";

const CTX: FormulaContextValues = {
  SigningDate: "2026-08-26",
  SigningLocation: "Đà Lạt",
  DocumentDate: "2026-08-20",
  ReceivedDate: "2026-08-25",
  ReceivedBy: "Nguyễn Văn A",
};

function ok(expr: string, values: FormulaContextValues = CTX): string {
  const r = resolveFormula(expr, values);
  assert.equal(r.ok, true, r.ok ? "" : `unexpected error: ${JSON.stringify((r as { error: unknown }).error)}`);
  return (r as { ok: true; value: string }).value;
}

function failCode(expr: string, values: FormulaContextValues = CTX): string {
  const r = resolveFormula(expr, values);
  assert.equal(r.ok, false, `expected failure, got value: ${JSON.stringify((r as { value?: unknown }).value)}`);
  return (r as { ok: false; error: { code: string } }).error.code;
}

/* ---------------------------------------------------------------- *
 * PHASE 4/11 — the 8 functions.
 * ---------------------------------------------------------------- */

test("day/month/year: basic extraction, zero-padded", () => {
  assert.equal(ok("day(SigningDate)"), "26");
  assert.equal(ok("month(SigningDate)"), "08");
  assert.equal(ok("year(SigningDate)"), "2026");
});

test("day/month/year: single-digit day/month still zero-padded", () => {
  const ctx: FormulaContextValues = { SigningDate: "2026-01-05" };
  assert.equal(ok("day(SigningDate)", ctx), "05");
  assert.equal(ok("month(SigningDate)", ctx), "01");
});

test("formatDate: dd/MM/yyyy, dd-MM-yyyy, yyyy-MM-dd", () => {
  assert.equal(ok('formatDate(SigningDate, "dd/MM/yyyy")'), "26/08/2026");
  assert.equal(ok('formatDate(SigningDate, "dd-MM-yyyy")'), "26-08-2026");
  assert.equal(ok('formatDate(SigningDate, "yyyy-MM-dd")'), "2026-08-26");
});

test("formatDate: unpadded d/M tokens", () => {
  const ctx: FormulaContextValues = { SigningDate: "2026-01-05" };
  assert.equal(ok('formatDate(SigningDate, "d/M/yyyy")', ctx), "5/1/2026");
});

test("formatDate: unsupported format token is rejected, not silently ignored", () => {
  assert.equal(failCode('formatDate(SigningDate, "yyyy-MM-dd HH:mm")'), "FORMULA_UNSUPPORTED_FORMAT");
  assert.equal(failCode('formatDate(SigningDate, "EEEE, dd MMMM yyyy")'), "FORMULA_UNSUPPORTED_FORMAT");
});

test("upper: Vietnamese-safe uppercase", () => {
  assert.equal(ok('upper("đà lạt")'), "ĐÀ LẠT");
  assert.equal(ok("upper(SigningLocation)"), "ĐÀ LẠT");
});

test("upper: null-safe (missing identifier -> null passthrough)", () => {
  assert.equal(ok("upper(ReceivedBy)", {}), "");
});

test("trim: removes leading/trailing whitespace only, preserves internal", () => {
  assert.equal(ok('trim("  Đà   Lạt  ")'), "Đà   Lạt");
});

test("coalesce: first non-null/non-empty value wins", () => {
  assert.equal(ok('coalesce(SigningLocation, "Đà Lạt")'), "Đà Lạt");
  assert.equal(ok('coalesce(SigningLocation, "Đà Lạt")', {}), "Đà Lạt");
});

test("coalesce: empty string is treated as absent, not as a value", () => {
  assert.equal(ok('coalesce(SigningLocation, "Đà Lạt")', { SigningLocation: "" }), "Đà Lạt");
});

test("coalesce: all-null resolves to empty string at top level", () => {
  assert.equal(ok("coalesce(SigningLocation, ReceivedBy)", {}), "");
});

test("concat: deterministic string concatenation with explicit null-to-empty behavior", () => {
  assert.equal(ok('concat(day(SigningDate), "/", month(SigningDate), "/", year(SigningDate))'), "26/08/2026");
  assert.equal(ok('concat("A", ReceivedBy, "B")', {}), "AB");
});

/* ---------------------------------------------------------------- *
 * PHASE 13/14 — the exact priority-candidate mapping examples.
 * ---------------------------------------------------------------- */

test("mapping example: Nam_thue -> year(SigningDate)", () => {
  assert.equal(ok("year(SigningDate)"), "2026");
});

test("mapping example: Dia_diem_ky -> coalesce(SigningLocation, \"Đà Lạt\")", () => {
  assert.equal(ok('coalesce(SigningLocation, "Đà Lạt")'), "Đà Lạt");
  assert.equal(ok('coalesce(SigningLocation, "Đà Lạt")', { SigningLocation: "Hà Nội" }), "Hà Nội");
});

test("mapping example: Ngay_tiep_nhan -> formatDate(ReceivedDate, \"dd/MM/yyyy\")", () => {
  assert.equal(ok('formatDate(ReceivedDate, "dd/MM/yyyy")'), "25/08/2026");
});

/* ---------------------------------------------------------------- *
 * PHASE 7 — grammar / nesting.
 * ---------------------------------------------------------------- */

test("nested calls are allowed", () => {
  assert.equal(ok('upper(coalesce(SigningLocation, "đà lạt"))'), "ĐÀ LẠT");
});

test("bare identifier and bare string literal are valid top-level expressions", () => {
  assert.equal(ok("SigningLocation"), "Đà Lạt");
  assert.equal(ok('"static text"'), "static text");
});

/* ---------------------------------------------------------------- *
 * PHASE 5 — identifier whitelist / no dot access / no arbitrary refs.
 * ---------------------------------------------------------------- */

test("unknown identifier is rejected", () => {
  assert.equal(failCode("Today"), "FORMULA_UNKNOWN_IDENTIFIER");
  assert.equal(failCode("candidate"), "FORMULA_UNKNOWN_IDENTIFIER");
});

test("dot-property access is not part of the grammar at all -> syntax error", () => {
  for (const expr of ["candidate.foo", "process.env", "globalThis.x", "window.x", "SigningDate.toString"]) {
    assert.equal(failCode(expr), "FORMULA_SYNTAX_ERROR", expr);
  }
});

test("dangerous-looking identifiers are rejected as unknown, never specially interpreted", () => {
  for (const expr of ["constructor", "prototype", "__proto__"]) {
    assert.equal(failCode(expr), "FORMULA_UNKNOWN_IDENTIFIER", expr);
  }
});

/* ---------------------------------------------------------------- *
 * PHASE 4 — unknown function.
 * ---------------------------------------------------------------- */

test("unknown function name is rejected", () => {
  assert.equal(failCode("foo(SigningDate)"), "FORMULA_UNKNOWN_FUNCTION");
});

test("function names are case-sensitive", () => {
  assert.equal(failCode("Day(SigningDate)"), "FORMULA_UNKNOWN_FUNCTION");
  assert.equal(failCode("DAY(SigningDate)"), "FORMULA_UNKNOWN_FUNCTION");
  assert.equal(failCode("FormatDate(SigningDate, \"dd\")"), "FORMULA_UNKNOWN_FUNCTION");
});

/* ---------------------------------------------------------------- *
 * HARD SECURITY RULE — no JS execution of any kind is reachable.
 * ---------------------------------------------------------------- */

test("SECURITY: no eval/Function/import/require path exists — these are just unknown identifiers/functions, never executed", () => {
  const dangerous = [
    "eval(SigningDate)",
    "Function(SigningDate)",
    'require("fs")',
    "import(SigningDate)",
    "constructor(SigningDate)",
    'process.env.DATABASE_URL',
  ];
  for (const expr of dangerous) {
    const r = resolveFormula(expr, CTX);
    assert.equal(r.ok, false, expr);
  }
});

test("SECURITY: no loop/control-flow syntax exists in the grammar (for/while/if are just unknown identifiers)", () => {
  for (const expr of ["for(SigningDate)", "while(SigningDate)", "if(SigningDate)"]) {
    assert.equal(failCode(expr), "FORMULA_UNKNOWN_FUNCTION", expr);
  }
});

/* ---------------------------------------------------------------- *
 * PHASE 6 — literals.
 * ---------------------------------------------------------------- */

test("string literals support escaped quotes and backslashes", () => {
  assert.equal(ok('concat("a\\"b")'), 'a"b');
  assert.equal(ok('concat("a\\\\b")'), "a\\b");
});

test("number literals stringify for concat", () => {
  assert.equal(ok('concat("x", 5, "y")'), "x5y");
});

test("unterminated string literal is a syntax error, never throws raw", () => {
  assert.equal(failCode('concat("unterminated'), "FORMULA_SYNTAX_ERROR");
});

/* ---------------------------------------------------------------- *
 * PHASE 11 — invalid argument counts.
 * ---------------------------------------------------------------- */

test("wrong argument count is a structured error, not a crash", () => {
  assert.equal(failCode("day(SigningDate, SigningLocation)"), "FORMULA_INVALID_ARGUMENT");
  assert.equal(failCode("day()"), "FORMULA_INVALID_ARGUMENT");
  assert.equal(failCode('formatDate(SigningDate)'), "FORMULA_INVALID_ARGUMENT");
  assert.equal(failCode("coalesce()"), "FORMULA_INVALID_ARGUMENT"); // parses fine (0 args), arity check (min 1) rejects it
});

test("invalid date input is a structured FORMULA_INVALID_DATE, not a JS Date NaN leak", () => {
  assert.equal(failCode('day("not a date")'), "FORMULA_INVALID_DATE");
  assert.equal(failCode('year("2026-02-30")'), "FORMULA_INVALID_DATE"); // not a real calendar date
});

test("day/month/year on a missing (null) identifier resolves to empty, not an error — matches other field types' missing-data behavior", () => {
  assert.equal(ok("day(SigningDate)", {}), "");
});

/* ---------------------------------------------------------------- *
 * PHASE 8 — resource limits.
 * ---------------------------------------------------------------- */

test("MAX_EXPRESSION_LENGTH is enforced", () => {
  const long = `concat(${'"x",'.repeat(200)}"y")`;
  assert.ok(long.length > MAX_EXPRESSION_LENGTH);
  assert.equal(failCode(long), "FORMULA_LIMIT_EXCEEDED");
});

test("MAX_AST_DEPTH is enforced against pathological nesting", () => {
  let expr = "SigningLocation";
  for (let i = 0; i < MAX_AST_DEPTH + 5; i += 1) expr = `upper(${expr})`;
  assert.equal(failCode(expr), "FORMULA_LIMIT_EXCEEDED");
});

test("a reasonable nesting depth within the limit succeeds", () => {
  let expr = "SigningLocation";
  for (let i = 0; i < MAX_AST_DEPTH - 2; i += 1) expr = `trim(${expr})`;
  const r = resolveFormula(expr, CTX);
  assert.equal(r.ok, true);
});

test("MAX_ARGUMENTS is enforced per call", () => {
  const args = Array.from({ length: MAX_ARGUMENTS + 5 }, (_, i) => `"${i}"`).join(", ");
  assert.equal(failCode(`concat(${args})`), "FORMULA_LIMIT_EXCEEDED");
});

test("MAX_FUNCTION_CALLS is enforced across the whole expression (deeply-nested variant, may also trip MAX_AST_DEPTH — both share the same error code)", () => {
  let expr = "SigningLocation";
  for (let i = 0; i < MAX_FUNCTION_CALLS + 5; i += 1) expr = `trim(${expr})`;
  const r = resolveFormula(expr, CTX);
  assert.equal(r.ok, false);
  assert.equal((r as { error: { code: string } }).error.code, "FORMULA_LIMIT_EXCEEDED");
});

test("MAX_FUNCTION_CALLS is enforced even when SHALLOW (wide, not deep) — isolates it from MAX_AST_DEPTH", () => {
  // depth stays at 3 (outer concat -> inner concat -> trim), but total call
  // count is 1 + 10*(1 concat + 2 trim) = 31, well past MAX_FUNCTION_CALLS.
  const branch = 'concat(trim("a"), trim("b"))';
  const expr = `concat(${Array.from({ length: 10 }, () => branch).join(", ")})`;
  assert.equal(failCode(expr), "FORMULA_LIMIT_EXCEEDED");
});

test("MAX_OUTPUT_LENGTH is enforced on the evaluated result", () => {
  const bigLiteral = `"${"x".repeat(MAX_OUTPUT_LENGTH + 10)}"`;
  assert.equal(failCode(`concat(${bigLiteral})`), "FORMULA_LIMIT_EXCEEDED");
});

/* ---------------------------------------------------------------- *
 * PARSE / EVALUATE split (Phase 23 needs validation without real context).
 * ---------------------------------------------------------------- */

test("parseFormula validates independently of any context values (for pre-save validation UX)", () => {
  const parsed = parseFormula("year(SigningDate)");
  assert.equal(parsed.ok, true);
  const badParsed = parseFormula("foo(SigningDate)");
  assert.equal(badParsed.ok, false);
});

test("evaluateFormula runs a pre-parsed ast against concrete values, reusable across many candidates", () => {
  const parsed = parseFormula("year(SigningDate)");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const a = evaluateFormula(parsed.ast, { SigningDate: "2025-01-01" });
  const b = evaluateFormula(parsed.ast, { SigningDate: "2026-08-26" });
  assert.equal(a.ok && a.value, "2025");
  assert.equal(b.ok && b.value, "2026");
});

/* ---------------------------------------------------------------- *
 * Determinism — no wall-clock access anywhere.
 * ---------------------------------------------------------------- */

test("DETERMINISM: identical expression + identical context always produces identical output, never touches wall-clock time", () => {
  const a = ok('concat(day(SigningDate), "/", month(SigningDate), "/", year(SigningDate))');
  const b = ok('concat(day(SigningDate), "/", month(SigningDate), "/", year(SigningDate))');
  assert.equal(a, b);
  assert.equal(a, "26/08/2026");
});
