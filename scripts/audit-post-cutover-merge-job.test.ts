/**
 * REGRESSION TESTS — scripts/audit-post-cutover-merge-job.mjs must stay
 * strictly read-only and never select candidate PII. Raw template content
 * (htmlBody/printCss — placeholders, not candidate data) is dumped ONLY when
 * DUMP_CONTENT is explicitly opted in, matching
 * audit-remediate-published-template-margins.mjs's existing convention.
 * Structural source tests, matching this repo's established pattern (see
 * diagnose-stuck-merge-jobs.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/audit-post-cutover-merge-job.mjs";
const WORKFLOW_PATH = ".github/workflows/audit-post-cutover-merge-job.yml";

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

test("script never selects candidate PII — no source_record_id, no daily_applications/dw_data/worker_profiles join", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /source_record_id/);
  assert.doesNotMatch(code, /daily_applications/);
  assert.doesNotMatch(code, /dw_data/);
  assert.doesNotMatch(code, /worker_profiles/);
});

test("script never logs raw template htmlBody/printCss content — only lengths and sha256 hashes", () => {
  const code = readScript();
  assert.match(code, /htmlBodyLength/);
  assert.match(code, /htmlBodySha256/);
  assert.match(code, /printCssLength/);
  assert.match(code, /printCssSha256/);
  // The snapshot object built for logging must never spread/pass through the
  // raw htmlBody/printCss strings themselves.
  const snapshotsBlock = code.slice(code.indexOf("const snapshots ="), code.indexOf("console.log(\n  JSON.stringify({\n    event: \"job\","));
  assert.doesNotMatch(snapshotsBlock, /htmlBody:\s*snap\?\.htmlBody\b/);
  assert.doesNotMatch(snapshotsBlock, /printCss:\s*snap\?\.printCss\b/);
});

test("script cross-checks the frozen snapshot against the CURRENTLY PUBLISHED version via merge_templates.current_published_version join", () => {
  const code = readScript();
  assert.match(code, /current_published_version/);
  assert.match(code, /versionMatches/);
  assert.match(code, /htmlBodyContentIdentical/);
  assert.match(code, /printCssContentIdentical/);
  assert.match(code, /snapshotMarginsMatchPublished/);
});

test("margin comparison reads the canonical PageMargins key names (topMm/bottomMm/leftMm/rightMm) — not top/bottom/left/right, which the frozen snapshot never uses (see canonical-document.ts's PageMargins shape)", () => {
  const code = readScript();
  const block = code.slice(code.indexOf("snapshotMarginsMatchPublished:"), code.indexOf("htmlBodyContentIdentical:"));
  assert.match(block, /snap\.margins\?\.topMm/);
  assert.match(block, /snap\.margins\?\.bottomMm/);
  assert.match(block, /snap\.margins\?\.leftMm/);
  assert.match(block, /snap\.margins\?\.rightMm/);
});

test("DUMP_CONTENT is opt-in only (accepts GitHub Actions' boolean workflow_dispatch string \"true\", not just \"1\") and gates the only content_dump emission", () => {
  const code = readScript();
  assert.match(code, /DUMP_CONTENT\s*=\s*process\.env\.DUMP_CONTENT === "1" \|\| process\.env\.DUMP_CONTENT === "true"/);
  assert.match(code, /if \(DUMP_CONTENT\) \{/);
  const dumpBlock = code.slice(code.indexOf("if (DUMP_CONTENT)"));
  assert.match(dumpBlock, /event: "content_dump"/);
  assert.equal((code.match(/event: "content_dump"/g) ?? []).length, 1, "content_dump must be emitted from exactly one place, inside the DUMP_CONTENT gate");
});

test("script requires DATABASE_URL and exits non-zero without it", () => {
  const code = readScript();
  assert.match(code, /if \(!DATABASE_URL\)/);
  assert.match(code, /process\.exit\(1\)/);
});

test("output is single-line NDJSON (no pretty-print)", () => {
  const code = readScript();
  assert.doesNotMatch(code, /JSON\.stringify\([^)]*,\s*null,\s*2\)/);
});

test("job_records query selects only queue/output-existence columns — never source_record_id", () => {
  const code = readScript();
  const recordsQueryStart = code.indexOf("SELECT id, status, template_id");
  const recordsQueryEnd = code.indexOf("FROM merge_job_records");
  assert.ok(recordsQueryStart > -1 && recordsQueryEnd > recordsQueryStart);
  const recordsQuery = code.slice(recordsQueryStart, recordsQueryEnd);
  assert.doesNotMatch(recordsQuery, /source_record_id/);
});

test("workflow is workflow_dispatch only, scoped to the production environment, never calls the worker /run endpoint", () => {
  const workflow = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /\/run["']/);
  assert.doesNotMatch(workflow, /\/publish["']/);
});
