/**
 * REGRESSION TESTS — scripts/diagnose-google-docs-render-parity.mjs must stay
 * strictly read-only and never select candidate PII. Structural source
 * tests, matching this repo's established pattern (see
 * diagnose-stuck-merge-jobs.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/diagnose-google-docs-render-parity.mjs";

function readScript(): string {
  return readFileSync(join(ROOT, SCRIPT_PATH), "utf8");
}

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("diagnostic script never mutates the database or a Google Doc (no UPDATE/DELETE/INSERT, no Docs batchUpdate)", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /\bUPDATE\s+merge_/i);
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(code, /\bTRUNCATE\b/i);
  assert.doesNotMatch(code, /\bDROP\b/i);
  assert.doesNotMatch(code, /batchUpdate/i);
  // The only POST in this script is the unrelated OAuth token exchange
  // (https://oauth2.googleapis.com/token) — the Docs API fetch (against
  // docs.googleapis.com) must carry no "method" (defaults to GET).
  const docsApiUrlIndex = code.indexOf("docs.googleapis.com");
  assert.ok(docsApiUrlIndex > -1, "expected a docs.googleapis.com URL");
  const nearDocsUrl = code.slice(docsApiUrlIndex, docsApiUrlIndex + 300);
  assert.doesNotMatch(nearDocsUrl, /method/);
});

test("diagnostic script never selects candidate PII — no source_record_id, no daily_applications/dw_data/worker_profiles join", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /source_record_id/);
  assert.doesNotMatch(code, /daily_applications/);
  assert.doesNotMatch(code, /dw_data/);
  assert.doesNotMatch(code, /worker_profiles/);
});

test("Google Docs read is restricted to the documentStyle field mask — never reads body.content", () => {
  const code = stripJsComments(readScript());
  assert.match(code, /fields=documentStyle/);
  assert.doesNotMatch(code, /fields=.*body/i);
  assert.doesNotMatch(code, /\bbody\.content\b/);
});

test("real job snapshot report proves margins are absent from GOOGLE_DOCS job metadata regardless of what's stored (worker-side type has no margin fields)", () => {
  const code = readScript();
  assert.match(code, /hasMarginsInMetadata/);
  assert.match(code, /engine = 'GOOGLE_DOCS'/);
});

test("diagnostic script requires DATABASE_URL and exits non-zero without it; degrades gracefully without Google OAuth env", () => {
  const code = readScript();
  assert.match(code, /if \(!DATABASE_URL\)/);
  assert.match(code, /process\.exit\(1\)/);
  assert.match(code, /google_oauth_unavailable/);
});

test("output is single-line NDJSON (no pretty-print)", () => {
  const code = readScript();
  assert.doesNotMatch(code, /JSON\.stringify\([^)]*,\s*null,\s*2\)/);
});

test("diagnostic workflow is workflow_dispatch only, scoped to the production environment, never calls the worker /run endpoint or publishes anything", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/diagnose-google-docs-render-parity.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /\/run["']/);
  assert.doesNotMatch(workflow, /\/publish["']/);
});
