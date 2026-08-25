/**
 * CSS SCANNER — deterministic, dependency-free CSS parser for the AI Template
 * Analyze workflow (H1). Pure text-in, data-out; never executes/evaluates CSS.
 *
 * Scope: enough structure to (a) validate brace/string balance, (b) list
 * declarations per selector for the layout-risk scanner, and (c) detect
 * dangerous constructs anywhere in the source for the security scanner. This
 * is intentionally NOT a full CSS3 grammar (no full selector combinators, no
 * real cascade/specificity resolution) — see ai-template-layout.ts for the
 * documented heuristic used to match declarations to elements.
 */

export interface CssDeclaration {
  property: string;
  value: string;
}

export interface CssRule {
  /** Raw selector list text, e.g. "td.addr, .addr2". */
  selectorText: string;
  /** Selector list split on top-level commas, trimmed. */
  selectors: string[];
  declarations: CssDeclaration[];
  /** Enclosing at-rule chain, e.g. ["@media print"], [] for a top-level rule. */
  atRuleContext: string[];
}

export interface CssValidationIssue {
  code: "UNBALANCED_BRACES" | "UNTERMINATED_STRING" | "UNTERMINATED_COMMENT";
  message: string;
}

export interface CssParseResult {
  rules: CssRule[];
  /** Non-rule at-statements such as @import "x.css"; and @font-face bodies. */
  atStatements: string[];
  issues: CssValidationIssue[];
  /** Comment-stripped, string-preserving source — used by the security scanner. */
  sourceWithoutComments: string;
}

/** Strip /* ... *\/ comments while leaving string contents untouched. Reports an unterminated comment. */
function stripComments(css: string): { text: string; issues: CssValidationIssue[] } {
  let out = "";
  const issues: CssValidationIssue[] = [];
  let i = 0;
  let inString: '"' | "'" | null = null;
  while (i < css.length) {
    const ch = css[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // preserve escaped char verbatim
        if (i + 1 < css.length) {
          out += css[i + 1];
          i += 2;
          continue;
        }
      } else if (ch === inString) {
        inString = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      if (close === -1) {
        issues.push({ code: "UNTERMINATED_COMMENT", message: "Comment CSS (/* ... */) chưa được đóng." });
        i = css.length;
        break;
      }
      i = close + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  if (inString) {
    issues.push({ code: "UNTERMINATED_STRING", message: `Chuỗi CSS (${inString}...) chưa được đóng.` });
  }
  return { text: out, issues };
}

function parseDeclarationBlock(body: string): CssDeclaration[] {
  const decls: CssDeclaration[] = [];
  for (const part of splitTopLevel(body, ";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const property = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    if (property) decls.push({ property, value });
  }
  return decls;
}

/** Split on a delimiter, but never inside (), "", or ''. */
function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0 || parts.length === 0) parts.push(current);
  return parts;
}

/**
 * Parse CSS text into rules + at-statements. Never throws on malformed input
 * — structural problems are reported as issues, the parser recovers by
 * treating the rest of the source as best-effort.
 */
export function parseCss(css: string): CssParseResult {
  const { text, issues } = stripComments(css ?? "");
  const rules: CssRule[] = [];
  const atStatements: string[] = [];
  const atRuleContext: string[] = [];

  let i = 0;
  let buf = "";
  let sawUnterminatedBlock = false;

  // At-rules whose body is a plain declaration list (like an ordinary rule),
  // not a nested set of rules — @page/@font-face/@counter-style/@viewport.
  const DECLARATION_AT_RULES = /^@(page|font-face|counter-style|viewport)\b/i;

  function commitRule(selectorText: string, body: string) {
    const selectors = selectorText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    rules.push({
      selectorText: selectorText.trim(),
      selectors,
      declarations: parseDeclarationBlock(body),
      atRuleContext: [...atRuleContext],
    });
  }

  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      const header = buf.trim();
      buf = "";
      const closeIdx = findMatchingBrace(text, i);
      if (closeIdx === -1) sawUnterminatedBlock = true;
      const body = text.slice(i + 1, closeIdx === -1 ? text.length : closeIdx);

      if (header.startsWith("@") && !DECLARATION_AT_RULES.test(header)) {
        // A rule-nesting at-rule (@media, @supports, @document, @keyframes,
        // ...): descend, remember the header so nested rules keep context.
        atRuleContext.push(header);
        const nested = parseCss(body);
        for (const r of nested.rules) rules.push({ ...r, atRuleContext: [...atRuleContext, ...r.atRuleContext] });
        atStatements.push(...nested.atStatements);
        issues.push(...nested.issues);
        atRuleContext.pop();
      } else {
        // Ordinary rule OR a declaration-bodied at-rule (@page/@font-face/...).
        commitRule(header, body);
      }
      i = closeIdx === -1 ? text.length : closeIdx + 1;
      continue;
    }
    if (ch === "}") {
      // Stray close brace with no opener at this level — recorded, skipped.
      i += 1;
      continue;
    }
    if (ch === ";" && buf.trim().startsWith("@")) {
      atStatements.push(buf.trim() + ";");
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }

  if (sawUnterminatedBlock) {
    issues.push({ code: "UNBALANCED_BRACES", message: "Số dấu { và } trong CSS không cân bằng." });
  }

  return { rules, atStatements, issues, sourceWithoutComments: text };
}

/** Find the index of the '}' matching the '{' at openIdx, honoring nested braces and strings. Returns -1 if unterminated. */
function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  let inString: '"' | "'" | null = null;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract the raw url(...) argument list from a CSS value. Manually scans
 * for balanced parens (rather than a single regex) so a malformed/adversarial
 * argument containing its own parens — e.g. url(javascript:alert(1)) — is
 * still captured whole instead of being truncated at the first ')'.
 */
export function extractCssUrls(value: string): string[] {
  const urls: string[] = [];
  const re = /url\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const argStart = m.index + m[0].length;
    let depth = 1;
    let i = argStart;
    let inString: '"' | "'" | null = null;
    while (i < value.length && depth > 0) {
      const ch = value[i];
      if (inString) {
        if (ch === inString) inString = null;
      } else if (ch === '"' || ch === "'") {
        inString = ch;
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    let arg = value.slice(argStart, i).trim();
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      arg = arg.slice(1, -1);
    }
    urls.push(arg);
    re.lastIndex = i + 1;
  }
  return urls;
}
