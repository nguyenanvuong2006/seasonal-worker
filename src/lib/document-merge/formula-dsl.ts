/**
 * SAFE FORMULA DSL V1 — computed-placeholder expressions (e.g.
 * `day(SigningDate)`, `coalesce(SigningLocation, "Đà Lạt")`).
 *
 * HARD SECURITY RULE: this is NOT a JavaScript interpreter. There is no
 * eval(), no `new Function()`, no dynamic import, no VM, no reflection, no
 * dot-property access, no loops, no user-defined functions. The pipeline is
 * strictly:
 *
 *   TOKENIZE -> PARSE TO AST -> VALIDATE (whitelist) -> EVALUATE
 *
 * Every identifier and every function name is checked against a closed
 * whitelist BEFORE evaluation ever runs. Evaluation itself only ever
 * dispatches to one of the 8 built-in, hand-written functions below — it
 * never executes anything derived from the input string as code.
 *
 * Pure, dependency-free (no db, no next, no io, no Date.now()/wall clock —
 * every date value it operates on is supplied explicitly by the caller).
 */

// ==========================================================================
// RESOURCE LIMITS (Phase 8) — protect the parser/evaluator from pathological
// input. Expressions are short, hand-authored mapping configuration, not
// user-generated documents, so these are deliberately tight.
// ==========================================================================
export const MAX_EXPRESSION_LENGTH = 500;
export const MAX_AST_DEPTH = 8;
export const MAX_ARGUMENTS = 10;
export const MAX_FUNCTION_CALLS = 20;
export const MAX_OUTPUT_LENGTH = 2000;

// ==========================================================================
// WHITELISTS (Phase 4/5) — the ENTIRE surface of what this DSL can ever
// reference or call. Nothing outside these two lists is reachable.
// ==========================================================================

/** The only 8 functions V1 supports. Case-sensitive, exact match. */
const FUNCTION_ARITY: Record<string, { min: number; max: number }> = {
  day: { min: 1, max: 1 },
  month: { min: 1, max: 1 },
  year: { min: 1, max: 1 },
  formatDate: { min: 2, max: 2 },
  upper: { min: 1, max: 1 },
  trim: { min: 1, max: 1 },
  coalesce: { min: 1, max: MAX_ARGUMENTS },
  concat: { min: 1, max: MAX_ARGUMENTS },
};

/**
 * The only identifiers V1 may reference — the Signing Context surface
 * (signing-context.ts). No `candidate.foo`, no `process.env`, no
 * `globalThis`/`window`/`document`/`constructor`/`prototype`/`__proto__` —
 * dot-property access does not exist in this grammar at all (Phase 5).
 */
export const ALLOWED_IDENTIFIERS = [
  "SigningDate",
  "SigningLocation",
  "DocumentDate",
  "ReceivedDate",
  "ReceivedBy",
  "SigningLatitude",
  "SigningLongitude",
  "SigningLocationCapturedAt",
] as const;
export type AllowedIdentifier = (typeof ALLOWED_IDENTIFIERS)[number];
const ALLOWED_IDENTIFIER_SET = new Set<string>(ALLOWED_IDENTIFIERS);

// ==========================================================================
// ERROR MODEL (Phase 12) — structured, never a raw stack trace, always an
// operator-friendly Vietnamese message.
// ==========================================================================
export type FormulaErrorCode =
  | "FORMULA_SYNTAX_ERROR"
  | "FORMULA_UNKNOWN_FUNCTION"
  | "FORMULA_UNKNOWN_IDENTIFIER"
  | "FORMULA_INVALID_ARGUMENT"
  | "FORMULA_INVALID_DATE"
  | "FORMULA_UNSUPPORTED_FORMAT"
  | "FORMULA_LIMIT_EXCEEDED";

export interface FormulaError {
  code: FormulaErrorCode;
  /** Operator-facing Vietnamese message — never a parser internal/stack trace. */
  message: string;
}

function err(code: FormulaErrorCode, message: string): FormulaError {
  return { code, message };
}

// ==========================================================================
// AST (Phase 7 grammar)
//
//   Expression :=
//     Identifier | StringLiteral | NumberLiteral | FunctionCall
//   FunctionCall := FunctionName "(" Arguments? ")"
//   Arguments := Expression ("," Expression)*
// ==========================================================================
export type FormulaNode =
  | { type: "Identifier"; name: string }
  | { type: "String"; value: string }
  | { type: "Number"; value: number }
  | { type: "Call"; name: string; args: FormulaNode[] };

// --------------------------------------------------------------------------
// TOKENIZER
// --------------------------------------------------------------------------
type TokenType = "IDENT" | "STRING" | "NUMBER" | "LPAREN" | "RPAREN" | "COMMA" | "EOF";
interface Token {
  type: TokenType;
  value: string;
}

class SyntaxFail extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "LPAREN", value: "(" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "RPAREN", value: ")" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "COMMA", value: "," });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < n) {
        const c = input[j];
        if (c === "\\" && j + 1 < n && (input[j + 1] === '"' || input[j + 1] === "\\")) {
          out += input[j + 1];
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          j += 1;
          break;
        }
        out += c;
        j += 1;
      }
      if (!closed) throw new SyntaxFail("unterminated string literal");
      tokens.push({ type: "STRING", value: out });
      i = j;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < n && ((input[j] >= "0" && input[j] <= "9") || input[j] === ".")) j += 1;
      tokens.push({ type: "NUMBER", value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ type: "IDENT", value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new SyntaxFail(`unexpected character '${ch}'`);
  }
  tokens.push({ type: "EOF", value: "" });
  return tokens;
}

// --------------------------------------------------------------------------
// PARSER (recursive descent — one Expression per grammar rule, no loops
// over user-defined constructs, only fixed recursion driven by nesting
// depth of the input itself, capped by MAX_AST_DEPTH in validate()).
// --------------------------------------------------------------------------
function parseExpression(tokens: Token[], pos: { i: number }): FormulaNode {
  const tok = tokens[pos.i];
  if (tok.type === "STRING") {
    pos.i += 1;
    return { type: "String", value: tok.value };
  }
  if (tok.type === "NUMBER") {
    pos.i += 1;
    return { type: "Number", value: Number(tok.value) };
  }
  if (tok.type === "IDENT") {
    pos.i += 1;
    if (tokens[pos.i].type === "LPAREN") {
      pos.i += 1; // consume "("
      const args: FormulaNode[] = [];
      if (tokens[pos.i].type !== "RPAREN") {
        args.push(parseExpression(tokens, pos));
        while (tokens[pos.i].type === "COMMA") {
          pos.i += 1;
          args.push(parseExpression(tokens, pos));
        }
      }
      if (tokens[pos.i].type !== "RPAREN") throw new SyntaxFail("expected ')'");
      pos.i += 1; // consume ")"
      return { type: "Call", name: tok.value, args };
    }
    return { type: "Identifier", name: tok.value };
  }
  throw new SyntaxFail(`unexpected token '${tok.value || tok.type}'`);
}

/** Parse the raw string into an AST, never throwing — errors come back structured. */
function parseToAst(expression: string): { ok: true; ast: FormulaNode } | { ok: false; error: FormulaError } {
  try {
    const tokens = tokenize(expression);
    const pos = { i: 0 };
    const ast = parseExpression(tokens, pos);
    if (tokens[pos.i].type !== "EOF") {
      return { ok: false, error: err("FORMULA_SYNTAX_ERROR", "Công thức không hợp lệ.") };
    }
    return { ok: true, ast };
  } catch {
    // Never leak the internal parser message/stack — structured error only.
    return { ok: false, error: err("FORMULA_SYNTAX_ERROR", "Công thức không hợp lệ.") };
  }
}

// --------------------------------------------------------------------------
// VALIDATE (Phase 4/5/8) — whitelist every node BEFORE evaluation ever runs.
// --------------------------------------------------------------------------
function validateAst(ast: FormulaNode): FormulaError | null {
  let callCount = 0;

  function walk(node: FormulaNode, depth: number): FormulaError | null {
    if (depth > MAX_AST_DEPTH) {
      return err("FORMULA_LIMIT_EXCEEDED", "Công thức lồng nhau quá sâu — vượt giới hạn cho phép.");
    }
    if (node.type === "Identifier") {
      if (!ALLOWED_IDENTIFIER_SET.has(node.name)) {
        return err("FORMULA_UNKNOWN_IDENTIFIER", `Biến "${node.name}" không tồn tại trong Signing Context.`);
      }
      return null;
    }
    if (node.type === "String" || node.type === "Number") return null;
    if (node.type === "Call") {
      const arity = FUNCTION_ARITY[node.name];
      if (!arity) {
        return err("FORMULA_UNKNOWN_FUNCTION", `Hàm "${node.name}" không được hỗ trợ.`);
      }
      callCount += 1;
      if (callCount > MAX_FUNCTION_CALLS) {
        return err("FORMULA_LIMIT_EXCEEDED", "Công thức gọi quá nhiều hàm — vượt giới hạn cho phép.");
      }
      if (node.args.length > MAX_ARGUMENTS) {
        return err("FORMULA_LIMIT_EXCEEDED", `Hàm "${node.name}" có quá nhiều tham số — vượt giới hạn cho phép.`);
      }
      if (node.args.length < arity.min || node.args.length > arity.max) {
        return err(
          "FORMULA_INVALID_ARGUMENT",
          `Hàm "${node.name}" cần ${arity.min === arity.max ? arity.min : `${arity.min}-${arity.max}`} tham số, nhận được ${node.args.length}.`,
        );
      }
      for (const arg of node.args) {
        const sub = walk(arg, depth + 1);
        if (sub) return sub;
      }
      return null;
    }
    return err("FORMULA_SYNTAX_ERROR", "Công thức không hợp lệ.");
  }

  return walk(ast, 1);
}

/**
 * TOKENIZE -> PARSE -> VALIDATE. Call this once per mapping save (Phase 23
 * "Thử công thức") and once per resolution — it is cheap and fully pure.
 */
export function parseFormula(expression: string): { ok: true; ast: FormulaNode } | { ok: false; error: FormulaError } {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return { ok: false, error: err("FORMULA_SYNTAX_ERROR", "Công thức không được để trống.") };
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, error: err("FORMULA_LIMIT_EXCEEDED", `Công thức vượt quá ${MAX_EXPRESSION_LENGTH} ký tự cho phép.`) };
  }
  const parsed = parseToAst(expression);
  if (!parsed.ok) return parsed;
  const validationError = validateAst(parsed.ast);
  if (validationError) return { ok: false, error: validationError };
  return { ok: true, ast: parsed.ast };
}

// --------------------------------------------------------------------------
// DATE SEMANTICS (Phase 9) — one deterministic representation.
//
// Date-ONLY values ("2026-08-26") are read as their literal calendar parts —
// NEVER reinterpreted through any timezone, so no shift is possible.
// Anything else is parsed as a timestamp and normalized to the application's
// configured business timezone (Asia/Ho_Chi_Minh — see formatters.ts'
// DISPLAY_TIMEZONE, the existing convention this reuses) so "today" always
// means the same calendar day a Vietnam-based operator sees on their clock.
// --------------------------------------------------------------------------
const BUSINESS_TIMEZONE = "Asia/Ho_Chi_Minh";
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface DateParts {
  day: string;
  month: string;
  year: string;
}

function isRealCalendarDate(y: number, m: number, d: number): boolean {
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

function parseDslDate(raw: string): DateParts | null {
  const trimmed = raw.trim();
  const dateOnly = DATE_ONLY_PATTERN.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    if (!isRealCalendarDate(Number(y), Number(m), Number(d))) return null;
    return { day: d, month: m, year: y };
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("day");
  const month = get("month");
  const year = get("year");
  if (!day || !month || !year) return null;
  return { day, month, year };
}

// --------------------------------------------------------------------------
// FORMATDATE ALLOWLIST (Phase 10) — dd, MM, yyyy, plus unpadded d/M. No
// arbitrary formatting engine; anything else in the pattern is rejected.
// --------------------------------------------------------------------------
const FORMAT_TOKEN_RE = /yyyy|MM|dd|M|d/g;
/** Only date tokens + common separators may appear in a format string. */
const ALLOWED_FORMAT_CHARS_RE = /^[dMy/\-. ]+$/;

function applyDateFormat(parts: DateParts, format: string): string | null {
  if (!ALLOWED_FORMAT_CHARS_RE.test(format)) return null;
  return format.replace(FORMAT_TOKEN_RE, (token) => {
    switch (token) {
      case "yyyy":
        return parts.year;
      case "MM":
        return parts.month;
      case "dd":
        return parts.day;
      case "M":
        return String(Number(parts.month));
      case "d":
        return String(Number(parts.day));
      default:
        return token;
    }
  });
}

// --------------------------------------------------------------------------
// EVALUATOR (Phase 11) — dispatches ONLY to these 8 hand-written functions.
// Every value in this DSL is `string | null` — there are no arrays/objects
// (Phase 6).
// --------------------------------------------------------------------------
type EvalValue = string | null;
export type FormulaContextValues = Partial<Record<AllowedIdentifier, EvalValue>>;

/** coalesce/required-ness treats "" the same as null — an empty signing field is "not set". */
function isAbsent(v: EvalValue): boolean {
  return v === null || v === undefined || v === "";
}

function evalNode(node: FormulaNode, values: FormulaContextValues): { ok: true; value: EvalValue } | { ok: false; error: FormulaError } {
  if (node.type === "String") return { ok: true, value: node.value };
  if (node.type === "Number") return { ok: true, value: String(node.value) };
  if (node.type === "Identifier") {
    // Whitelisted at validate() time — an unset context value is simply null,
    // exactly like an unmapped CORE_FIELD resolves to its fallback/empty.
    const v = values[node.name as AllowedIdentifier];
    return { ok: true, value: v === undefined ? null : v };
  }

  // node.type === "Call"
  const evaluatedArgs: EvalValue[] = [];
  for (const argNode of node.args) {
    const r = evalNode(argNode, values);
    if (!r.ok) return r;
    evaluatedArgs.push(r.value);
  }

  switch (node.name) {
    case "day":
    case "month":
    case "year": {
      const raw = evaluatedArgs[0];
      if (raw === null) return { ok: true, value: null };
      const parts = parseDslDate(raw);
      if (!parts) return { ok: false, error: err("FORMULA_INVALID_DATE", "Ngày không hợp lệ.") };
      return { ok: true, value: parts[node.name] };
    }
    case "formatDate": {
      const raw = evaluatedArgs[0];
      const format = evaluatedArgs[1];
      if (raw === null) return { ok: true, value: null };
      if (format === null) {
        return { ok: false, error: err("FORMULA_INVALID_ARGUMENT", "formatDate cần định dạng ngày (ví dụ dd/MM/yyyy).") };
      }
      const parts = parseDslDate(raw);
      if (!parts) return { ok: false, error: err("FORMULA_INVALID_DATE", "Ngày không hợp lệ.") };
      const formatted = applyDateFormat(parts, format);
      if (formatted === null) {
        return { ok: false, error: err("FORMULA_UNSUPPORTED_FORMAT", `Định dạng ngày "${format}" không được hỗ trợ.`) };
      }
      return { ok: true, value: formatted };
    }
    case "upper": {
      const v = evaluatedArgs[0];
      return { ok: true, value: v === null ? null : v.toLocaleUpperCase("vi-VN") };
    }
    case "trim": {
      const v = evaluatedArgs[0];
      return { ok: true, value: v === null ? null : v.trim() };
    }
    case "coalesce": {
      for (const v of evaluatedArgs) {
        if (!isAbsent(v)) return { ok: true, value: v };
      }
      return { ok: true, value: null };
    }
    case "concat": {
      // Null args become "" — deterministic, never throws on a missing piece.
      return { ok: true, value: evaluatedArgs.map((v) => v ?? "").join("") };
    }
    default:
      // Unreachable: validateAst() already rejected any other function name.
      return { ok: false, error: err("FORMULA_UNKNOWN_FUNCTION", `Hàm "${node.name}" không được hỗ trợ.`) };
  }
}

/**
 * Evaluate an ALREADY-VALIDATED ast (from parseFormula) against concrete
 * Signing Context values. Returns "" (never null) at the top level, matching
 * how every other mapping source type resolves a missing value — the
 * required-field guard downstream is what decides whether that blocks
 * anything (Phase 24), not this function.
 */
export function evaluateFormula(
  ast: FormulaNode,
  values: FormulaContextValues,
): { ok: true; value: string } | { ok: false; error: FormulaError } {
  const result = evalNode(ast, values);
  if (!result.ok) return result;
  const value = result.value ?? "";
  if (value.length > MAX_OUTPUT_LENGTH) {
    return { ok: false, error: err("FORMULA_LIMIT_EXCEEDED", `Kết quả công thức vượt quá ${MAX_OUTPUT_LENGTH} ký tự cho phép.`) };
  }
  return { ok: true, value };
}

/** parseFormula + evaluateFormula composed — the entry point resolvers use. */
export function resolveFormula(
  expression: string,
  values: FormulaContextValues,
): { ok: true; value: string } | { ok: false; error: FormulaError } {
  const parsed = parseFormula(expression);
  if (!parsed.ok) return parsed;
  return evaluateFormula(parsed.ast, values);
}
