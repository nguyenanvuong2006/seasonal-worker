/**
 * REGRESSION TESTS — scripts/audit-remediate-published-template-margins.mjs
 * must never mutate/publish the currently PUBLISHED version, must only ever
 * INSERT a new DRAFT, and must be idempotent. Structural source tests,
 * matching this repo's established pattern (see diagnose-stuck-merge-jobs.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/audit-remediate-published-template-margins.mjs";
const WORKFLOW_PATH = ".github/workflows/audit-remediate-published-template-margins.yml";

function readScript(): string {
  return readFileSync(join(ROOT, SCRIPT_PATH), "utf8");
}

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("script never UPDATEs/DELETEs merge_template_versions and never touches merge_templates at all", () => {
  const code = readScript();
  assert.doesNotMatch(code, /\bUPDATE\s+merge_/i);
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(code, /\bTRUNCATE\b/i);
  assert.doesNotMatch(code, /\bDROP\b/i);
  // Only ever SELECTs from merge_templates — never writes to it (so
  // current_published_version can never change via this script).
  assert.doesNotMatch(code, /INSERT INTO merge_templates\b/i);
  assert.doesNotMatch(code, /UPDATE merge_templates\b/i);
});

test("the only INSERT is into merge_template_versions with status DRAFT, and it always sets published_at/archived_at NULL", () => {
  const code = readScript();
  const inserts = [...code.matchAll(/INSERT\s+INTO\s+(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(inserts, ["merge_template_versions"], "exactly one INSERT target, and it must be merge_template_versions");
  assert.match(code, /'DRAFT'/);
  assert.match(code, /published_at, archived_at\)/);
  assert.match(code, /NULL, NULL\s*\n\s*FROM merge_template_versions/);
});

test("script never selects candidate data — no daily_applications/dw_data/worker_profiles/merge_jobs/document_history", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /daily_applications/);
  assert.doesNotMatch(code, /dw_data/);
  assert.doesNotMatch(code, /worker_profiles/);
  assert.doesNotMatch(code, /merge_jobs\b/);
  assert.doesNotMatch(code, /merge_job_records/);
  assert.doesNotMatch(code, /document_history/);
});

test("@page stripping is scoped to @page {...} blocks only — no other CSS rule is touched", () => {
  const code = readScript();
  assert.match(code, /AT_PAGE_RULE = \/@page\\s\*\\\{\[\^\}\]\*\\\}\/g/);
  assert.match(code, /printCss\.replace\(AT_PAGE_RULE, ""\)/);
});

test("DUMP_CONTENT accepts GitHub Actions' boolean workflow_dispatch string \"true\" (not just \"1\")", () => {
  const code = readScript();
  assert.match(code, /DUMP_CONTENT\s*=\s*process\.env\.DUMP_CONTENT === "1" \|\| process\.env\.DUMP_CONTENT === "true"/);
});

test("remediation is idempotent — a second run detects a matching existing DRAFT and skips re-insertion", () => {
  const code = readScript();
  assert.match(code, /status = 'DRAFT' AND html_body = \$2 AND print_css = \$3/);
  assert.match(code, /ALREADY_EXISTS/);
  assert.match(code, /existingDrafts\.length > 0/);
});

test("new DRAFT margins are always set to the canonical default 10\\/10\\/12\\/12", () => {
  const code = readScript();
  assert.match(code, /DEFAULT_MARGINS = \{ top: 10, bottom: 10, left: 12, right: 12 \}/);
});

test("new DRAFT copies html_body verbatim (byte-identical) — the script never parses or rewrites the body", () => {
  const code = readScript();
  const insertStatement = code.slice(code.indexOf("INSERT INTO merge_template_versions"), code.indexOf("RETURNING id, version") + "RETURNING id, version".length);
  assert.match(insertStatement, /SELECT template_id, \$2, 'DRAFT', html_body, \$3, source_docx_name/);
  // Inside the INSERT's own SELECT, html_body is copied as a bare column
  // (never rewritten) — it is never a bound/computed parameter there.
  assert.doesNotMatch(insertStatement, /html_body\s*=\s*\$/, "html_body must be copied via the SELECT, never passed as a rewritten bound parameter");
});

test("script requires DATABASE_URL and exits non-zero without it", () => {
  const code = readScript();
  assert.match(code, /if \(!DATABASE_URL\)/);
  assert.match(code, /process\.exit\(1\)/);
});

test("output is single-line NDJSON (no pretty-print) matching the repo's diagnostic-script convention", () => {
  const code = readScript();
  assert.doesNotMatch(code, /JSON\.stringify\([^)]*,\s*null,\s*2\)/, "must never pretty-print — downstream tooling parses one JSON object per line");
});

test("workflow requires confirm=PRODUCTION and backup_confirmed=true, scoped to the production environment, and never publishes/deletes", () => {
  const workflow = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
  assert.match(workflow, /confirm:/);
  assert.match(workflow, /backup_confirmed:/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /\/publish["']/, "this workflow must never call a publish endpoint");
  assert.doesNotMatch(workflow, /\/run["']/, "this workflow must never invoke the worker's /run endpoint");
});
