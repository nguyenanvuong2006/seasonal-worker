/**
 * REGRESSION TESTS — scripts/verify-econf-single-candidate.ts (2026-09).
 *
 * Unlike this repo's other production scripts, this one performs REAL
 * writes when DRY_RUN=false (by design — the mission requires actually
 * driving one real candidate through the pipeline). These tests instead
 * lock in the SAFETY properties that make that acceptable: it reuses the
 * real, already-tested business-logic functions rather than reimplementing
 * merge/PDF logic, it never issues/sends or confirms on behalf of the
 * candidate, DRY_RUN performs zero writes, and candidate selection is
 * bounded to exactly one, previously-untested candidate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/verify-econf-single-candidate.ts";
const WORKFLOW_PATH = ".github/workflows/verify-econf-single-candidate.yml";

function readScript(): string {
  return readFileSync(join(ROOT, SCRIPT_PATH), "utf8");
}

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("reuses the REAL createAsyncMergeJob/finalizeToReady functions — never reimplements merge or Google/storage logic", () => {
  const code = readScript();
  assert.match(code, /import\s*\{\s*createAsyncMergeJob,\s*AsyncJobValidationError\s*\}\s*from\s*"\.\.\/src\/lib\/document-merge\/async-job\.ts"/);
  assert.match(code, /import\s*\{\s*finalizeToReady,/);
  assert.match(code, /from\s*"\.\.\/src\/lib\/candidate-consent\/finalize\.ts"/);
});

test("never issues/sends the document — no call to the issue/issue-ready/reissue endpoints or functions", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /\/issue/i);
  assert.doesNotMatch(code, /issue-ready/i);
  assert.doesNotMatch(code, /\breissue\b/i);
});

test("never confirms on behalf of the candidate — no call to a confirm route/function, no document_confirmations write", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /confirm\/route/i);
  assert.doesNotMatch(code, /documentConfirmations/);
  assert.doesNotMatch(code, /\bconfirmedAtServer\b/);
});

test("DRY_RUN stops before any write — the dry-run branch returns immediately after logging the selection, before createAsyncMergeJob/insert/update are ever reached", () => {
  const code = stripJsComments(readScript());
  const dryRunIdx = code.indexOf("if (DRY_RUN) {");
  const dryRunBlockEnd = code.indexOf("\n  }", dryRunIdx);
  const dryRunBlock = code.slice(dryRunIdx, dryRunBlockEnd);
  assert.match(dryRunBlock, /return;/);
  assert.doesNotMatch(dryRunBlock, /createAsyncMergeJob|\.insert\(|\.update\(/);

  // And every write-capable call must appear AFTER this branch in the file,
  // never before it.
  const firstWriteIdx = Math.min(
    ...["createAsyncMergeJob(", ".insert(candidateDocuments", ".update(candidateDocuments"]
      .map((needle) => code.indexOf(needle))
      .filter((i) => i !== -1),
  );
  assert.ok(firstWriteIdx > dryRunBlockEnd, "every write must be reachable only after the DRY_RUN early return");
});

test("selects at most ONE candidate — loop breaks on the first eligible match, single-element recordIds array", () => {
  const code = readScript();
  const loopStart = code.indexOf("for (const candidate of candidates)");
  const loopEnd = code.indexOf("\n  }", loopStart);
  const loopBody = code.slice(loopStart, loopEnd);
  assert.match(loopBody, /\bbreak;/);
  assert.match(code, /recordIds:\s*\[chosen\.applicationId\]/);
});

test("excludes candidates that already have a candidate_documents row — never re-tests the same person twice", () => {
  const code = readScript();
  assert.match(code, /candidateDocuments\.applicationId/);
  assert.match(code, /notInArray\(dailyApplications\.id,\s*excludeIds\)/);
});

test("scopes candidate eligibility to assigned + non-rejected + not-deleted daily_applications rows", () => {
  const code = readScript();
  assert.match(code, /isNull\(dailyApplications\.deletedAt\)/);
  assert.match(code, /isNotNull\(dailyApplications\.deptId\)/);
  assert.match(code, /ne\(dailyApplications\.status,\s*"REJECTED"\)/);
});

test("worker calls never send a Google credential/token value — only jobId, docId, or key+pdfBase64+contentType bodies", () => {
  const code = readScript();
  const calls = [...code.matchAll(/callWorkerDirect[^(]*\([^)]*\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 3, "expected /run, /export-doc-pdf, /drive-upload-pdf calls");
  assert.doesNotMatch(code, /refresh_token|client_secret|access_token/i);
});

test("workflow requires confirm=PRODUCTION only when dry_run=false, and dry_run defaults to true", () => {
  const workflow = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
  assert.match(workflow, /confirm.*!=.*PRODUCTION/);
  assert.match(workflow, /default:\s*true/);
});

test("workflow is scoped to the production environment with the same DB-hostname guardrail as other production scripts", () => {
  const workflow = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /PROD_DATABASE_URL/);
  assert.match(workflow, /KNOWN_STAGING_HOST/);
});

test("worker Cloud Run auth (Google Cloud steps) is skipped entirely when dry_run=true — read-only mode needs no GCP credentials", () => {
  const workflow = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
  const authSteps = workflow.match(/if: \$\{\{ github\.event\.inputs\.dry_run == 'false' \}\}/g) ?? [];
  assert.ok(authSteps.length >= 3, "expected the GCP auth/gcloud/worker-url steps all gated behind dry_run==false");
});
