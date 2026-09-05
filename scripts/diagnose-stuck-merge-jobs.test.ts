/**
 * REGRESSION TESTS — scripts/diagnose-stuck-merge-jobs.mjs must stay strictly
 * read-only (production diagnostic run against real merge_jobs data) and
 * must never select candidate PII. Structural source tests, matching this
 * repo's established pattern (see watchdog-provisioning.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/diagnose-stuck-merge-jobs.mjs";

function readScript(): string {
  return readFileSync(join(ROOT, SCRIPT_PATH), "utf8");
}

/** Strip the top-of-file /** ... *\/ docblock and // line comments so assertions
 * about actual SQL/code can't accidentally match explanatory prose. */
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("diagnostic script never mutates the database (no UPDATE/DELETE/INSERT)", () => {
  const code = readScript();
  assert.doesNotMatch(code, /\bUPDATE\s+merge_/i);
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(code, /\bTRUNCATE\b/i);
  assert.doesNotMatch(code, /\bDROP\b/i);
});

test("diagnostic script never selects source_record_id (candidate FK) or joins daily_applications/dw_data/worker_profiles", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /source_record_id/);
  assert.doesNotMatch(code, /daily_applications/);
  assert.doesNotMatch(code, /dw_data/);
  assert.doesNotMatch(code, /worker_profiles/);
});

test("diagnostic script reports output artifact existence as booleans, never raw output URLs", () => {
  const code = readScript();
  assert.match(code, /output_pdf_url IS NOT NULL/);
  assert.match(code, /output_zip_url IS NOT NULL/);
  assert.match(code, /output_doc_id IS NOT NULL/);
  assert.doesNotMatch(code, /SELECT[\s\S]{0,200}\boutput_pdf_url\b(?!\s+IS)/i, "must never SELECT the raw output_pdf_url column");
});

test("diagnostic script requires DATABASE_URL and exits non-zero without it", () => {
  const code = readScript();
  assert.match(code, /if \(!DATABASE_URL\)/);
  assert.match(code, /process\.exit\(1\)/);
});

test("diagnostic script runs the exact watchdog-mode selection query (same predicates as worker/src/index.ts /run) to test starvation", () => {
  const code = readScript();
  assert.match(code, /status IN \('QUEUED', 'PROCESSING'\)/);
  assert.match(code, /engine IN \('HTML_PDF', 'GOOGLE_DOCS'\)/);
  assert.match(code, /LIMIT 1/);
});

test("diagnostic workflow is workflow_dispatch only, scoped to the production environment, and never calls the worker /run endpoint", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/diagnose-production-merge-jobs.yml"), "utf8");
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch: \{\}/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /\/run["']/, "diagnostic workflow must never invoke the worker's /run endpoint");
  assert.doesNotMatch(workflow, /jobs\s+run\b/, "diagnostic workflow must never force-run anything");
});
