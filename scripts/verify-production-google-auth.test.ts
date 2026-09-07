/**
 * REGRESSION TESTS — scripts/verify-production-google-auth.mjs must stay
 * strictly read-only against real Google Drive/Docs (no writes, no
 * candidate data) and must never print any secret/token value. Structural
 * source tests, matching this repo's established pattern (see
 * watchdog-provisioning.test.ts, diagnose-stuck-merge-jobs.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/verify-production-google-auth.mjs";

function readScript(): string {
  return readFileSync(join(ROOT, SCRIPT_PATH), "utf8");
}

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("script only ever makes GET requests to Drive/Docs (no POST/PATCH/PUT/DELETE against those APIs)", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /googleapis\.com\/drive[\s\S]{0,200}method:\s*["'](?:POST|PATCH|PUT|DELETE)["']/i);
  assert.doesNotMatch(code, /docs\.googleapis\.com[\s\S]{0,200}method:\s*["'](?:POST|PATCH|PUT|DELETE)["']/i);
});

test("script never logs access_token, refresh_token, or client_secret values", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /console\.log\([^)]*accessToken[^)]*\)/);
  assert.doesNotMatch(code, /console\.log\([^)]*REFRESH_TOKEN[^)]*\)/);
  assert.doesNotMatch(code, /console\.log\([^)]*CLIENT_SECRET[^)]*\)/);
});

test("Drive check requests metadata fields only, never file content", () => {
  const code = readScript();
  assert.match(code, /fields=id,name,mimeType,modifiedTime,trashed/);
  assert.doesNotMatch(code, /alt=media/);
});

test("Docs check limits the fields mask to documentId+title, never the document body", () => {
  const code = readScript();
  assert.match(code, /fields=documentId,title/);
  assert.doesNotMatch(code, /documents\.googleapis\.com[\s\S]{0,300}method:\s*["'](?:POST|PATCH|PUT|DELETE)["']/);
});

test("script uses the real, already-committed production template ID from production-readiness.ts (no new candidate/job data)", () => {
  const code = readScript();
  assert.match(code, /10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE/);
  assert.doesNotMatch(code, /merge_jobs|merge_job_records|daily_applications/);
});

test("script requires all 3 credential env vars and exits non-zero without them", () => {
  const code = readScript();
  assert.match(code, /if \(!CLIENT_ID \|\| !CLIENT_SECRET \|\| !REFRESH_TOKEN\)/);
  assert.match(code, /process\.exit\(1\)/);
});

test("workflow never passes the Google secrets through GITHUB_OUTPUT/GITHUB_ENV (fetch + mask + use in one step only) and is workflow_dispatch-only in the production environment", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/verify-production-google-auth.yml"), "utf8");
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch: \{\}/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /GITHUB_OUTPUT/);
  assert.doesNotMatch(workflow, /GITHUB_ENV/);
  assert.match(workflow, /::add-mask::\$\{GOOGLE_CLIENT_ID\}/);
  assert.match(workflow, /::add-mask::\$\{GOOGLE_CLIENT_SECRET\}/);
  assert.match(workflow, /::add-mask::\$\{GOOGLE_REFRESH_TOKEN\}/);
});
