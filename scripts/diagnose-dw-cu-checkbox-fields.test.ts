/**
 * REGRESSION TESTS — scripts/diagnose-dw-cu-checkbox-fields.mjs must stay
 * strictly read-only, never select candidate data, and never dump the full
 * (large) html_body/print_css — only lengths and bounded checkbox-field
 * snippets. Structural source tests, matching this repo's established
 * pattern (see audit-post-cutover-merge-job.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/diagnose-dw-cu-checkbox-fields.mjs";
const WORKFLOW_PATH = ".github/workflows/diagnose-dw-cu-checkbox-fields.yml";

function readScript(): string {
  return readFileSync(join(ROOT, SCRIPT_PATH), "utf8");
}

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("script never mutates the database — no UPDATE/DELETE/INSERT/TRUNCATE/DROP", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /\bUPDATE\s+\w/i);
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(code, /\bTRUNCATE\b/i);
  assert.doesNotMatch(code, /\bDROP\b/i);
});

test("script never selects candidate data — no daily_applications/dw_data/worker_profiles join, no source_record_id", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /source_record_id/);
  assert.doesNotMatch(code, /daily_applications/);
  assert.doesNotMatch(code, /dw_data/);
  assert.doesNotMatch(code, /worker_profiles/);
});

test("script never logs the full html_body/print_css — only lengths and bounded snippets (<=200 chars) around checkbox markers", () => {
  const code = readScript();
  assert.match(code, /htmlBodyLength/);
  assert.match(code, /printCssLength/);
  // The version-metadata log event must never pass the raw column through.
  const versionEventBlock = code.slice(code.indexOf('event: "version"') - 400, code.indexOf('event: "version"') + 200);
  assert.doesNotMatch(versionEventBlock, /html_body,\s*\n\s*status/);
  // Snippets are bounded slices (context: body.slice(...)), never the whole body.
  assert.match(code, /body\.slice\(Math\.max\(0, m\.index - \d+\), m\.index \+ \d+\)/);
  assert.doesNotMatch(code, /context:\s*body(?!\.slice)/);
});

test("script scopes to the two dual-routing templates only (document_kind IN ('A','B'))", () => {
  const code = readScript();
  assert.match(code, /document_kind\s+IN\s+\('A',\s*'B'\)/);
});

test("script reports the live field mapping (source_type/option_value/format_type) — the exact mechanism CHECKBOX_OPTION rendering depends on", () => {
  const code = readScript();
  assert.match(code, /source_type/);
  assert.match(code, /option_value/);
  assert.match(code, /format_type/);
  assert.match(code, /is_orphaned/);
});

test("workflow is workflow_dispatch-only, scoped to the production environment, with the same DB-hostname guardrail as other production-read scripts", () => {
  const workflow = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch: \{\}/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /PROD_DATABASE_URL/);
  assert.match(workflow, /KNOWN_STAGING_HOST/);
});
