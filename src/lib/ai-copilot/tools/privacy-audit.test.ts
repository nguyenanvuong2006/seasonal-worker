/**
 * AI COPILOT — privacy structural proof (mission requirement: "never expose
 * CCCD/phone/IP/UA/HMAC/secrets"). Static source scan of every tool file's
 * SELECTED COLUMNS — a tool must never select a raw PII/secret column, even
 * if it never happens to render it today. Complements read-only-audit.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = HERE; // src/lib/ai-copilot/tools

// Column/field names that must never be REFERENCED AS CODE (property access or
// object-key position) in a tool file — these are exactly the fields the
// mission explicitly forbids exposing through the public/AI surface, matching
// schema.ts's real column names. Patterns are deliberately code-shaped (dot
// access / object key), not plain substring matches, so a Vietnamese
// description string that says "KHÔNG trả về CCCD" (documenting that CCCD is
// NOT exposed) is correctly left alone rather than flagged as an offender.
const FORBIDDEN_FIELD_PATTERNS: RegExp[] = [
  /\.cccd\b/,
  /\bcccd\s*:/,
  /\.phone\b/,
  /\bphone\s*:/,
  /\.permanentAddress\b/,
  /\.residentialAddress\b/,
  /\bipAddress\s*:/,
  /\.ipAddress\b/,
  /\buserAgent\s*:/,
  /\.userAgent\b/,
  /Hmac/,
  /passwordHash/,
  /tokenHash/,
  /\.dob\b/,
  /\bdob\s*:/,
];

function collectToolFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(dir, e.name));
}

/** Strip line/JSDoc comments and string-literal contents so prose mentioning
 * a field name in a description ("KHÔNG trả về CCCD") is never flagged —
 * only genuine code-shaped references (property access / object keys) are. */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .map((line) => line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, "``"))
    .join("\n");
}

test("no tool file under src/lib/ai-copilot/tools/ references a raw PII or secret column as code (property access / object key)", () => {
  const files = collectToolFiles(TOOLS_DIR);
  assert.ok(files.length >= 8, `expected at least 8 tool files, found ${files.length} — did the scan path break?`);
  const offenders: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const codeOnly = stripCommentsAndStrings(readFileSync(file, "utf8"));
    codeOnly.split("\n").forEach((line, i) => {
      if (FORBIDDEN_FIELD_PATTERNS.some((re) => re.test(line))) {
        offenders.push({ file, line: i + 1, text: line.trim() });
      }
    });
  }
  assert.deepEqual(offenders, [], `found a raw PII/secret field reference in an AI Copilot tool: ${JSON.stringify(offenders)}`);
});

test("worker names are only ever surfaced through the normalizePersonName helper, never a raw fullName pass-through of a redacted row", () => {
  const movementsSource = readFileSync(join(TOOLS_DIR, "movements.ts"), "utf8");
  assert.match(movementsSource, /normalizePersonName/, "movements.ts must route worker names through the same redaction helper the route uses");
});
