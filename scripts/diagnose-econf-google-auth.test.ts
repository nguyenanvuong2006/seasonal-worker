/**
 * REGRESSION TESTS — scripts/diagnose-econf-google-auth.mjs must stay
 * strictly read-only and never select candidate PII. Structural source
 * tests, matching this repo's established pattern (see
 * diagnose-dw-cu-checkbox-fields.test.ts / audit-post-cutover-merge-job.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/diagnose-econf-google-auth.mjs";
const WORKFLOW_PATH = ".github/workflows/diagnose-econf-google-auth.yml";

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

test("script never selects candidate PII — no full_name/cccd/phone/address/dob columns", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /full_name/);
  assert.doesNotMatch(code, /\bcccd\b/);
  assert.doesNotMatch(code, /\bphone\b/);
  assert.doesNotMatch(code, /address/i);
  assert.doesNotMatch(code, /\bdob\b/);
  assert.doesNotMatch(code, /daily_applications/);
  assert.doesNotMatch(code, /dw_data/);
  assert.doesNotMatch(code, /worker_profiles/);
});

test("script reads candidate_documents, merge_job_records, and merge_jobs — the exact tables the mission asks to trace", () => {
  const code = readScript();
  assert.match(code, /FROM candidate_documents/);
  assert.match(code, /FROM merge_job_records/);
  assert.match(code, /FROM merge_jobs/);
  assert.match(code, /error_code/);
  assert.match(code, /error_message/);
});

test("script checks for the historical expired/revoked-token symptom directly from evidence, not assumption", () => {
  const code = readScript();
  assert.match(code, /expired or revoked/i);
  assert.match(code, /invalid_grant/i);
});

test("script never logs storage_key/pdf_sha256 raw values — presence booleans only (has_storage_key/has_sha256)", () => {
  const code = readScript();
  assert.match(code, /has_storage_key/);
  assert.match(code, /has_sha256/);
  assert.doesNotMatch(code, /SELECT[^;]*\bstorage_key\b(?!\s+IS\s+NOT\s+NULL)[^;]*FROM/is);
});

test("workflow is workflow_dispatch-only, scoped to the production environment, with the same DB-hostname guardrail as other production-read scripts", () => {
  const workflow = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch: \{\}/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /PROD_DATABASE_URL/);
  assert.match(workflow, /KNOWN_STAGING_HOST/);
});
