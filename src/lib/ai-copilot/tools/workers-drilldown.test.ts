/**
 * AI COPILOT — structural proof for the drill-down gap hardening mission
 * (find_current_workers). Static source scan, same convention as
 * read-only-audit.test.ts/privacy-audit.test.ts — the file imports
 * "server-only" and touches the DB, so it can't be executed directly by
 * plain `node --test` (see repo convention: DB-touching tool files are
 * proven structurally, not by importing them in a unit test).
 *
 * Asserts the mission's own non-negotiables actually hold in source:
 *   - RBAC/Data Scope are re-resolved from the session on every call (never
 *     trusts a model/caller-supplied scope).
 *   - Result set is capped to a small default/max — the model must never
 *     receive thousands of raw worker rows.
 *   - Cursor-based pagination exists for anything beyond the cap.
 *   - No generic SQL/raw-query escape hatch was introduced alongside it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKERS_FILE = join(HERE, "workers.ts");

function readSource(): string {
  return readFileSync(WORKERS_FILE, "utf8");
}

test("find_current_workers re-resolves Data Scope from the session on every call via getUserScope + intersectDepartmentFilter (never trusts a caller-supplied scope)", () => {
  const src = readSource();
  assert.match(src, /getUserScope\(ctx\.session\)/, "must call getUserScope(ctx.session) inside execute(), not accept scope as an argument");
  assert.match(src, /intersectDepartmentFilter\(scope, args\.departmentId\)/, "must intersect the requested departmentId with the session's own scope, never trust it directly");
  assert.match(src, /FORBIDDEN/, "must reject an out-of-scope departmentId rather than silently widening the scope");
});

test("find_current_workers caps result size — small default, small max, no unbounded query", () => {
  const src = readSource();
  const maxRowsMatch = src.match(/const MAX_ROWS = (\d+);/);
  const defaultRowsMatch = src.match(/const DEFAULT_ROWS = (\d+);/);
  assert.ok(maxRowsMatch, "MAX_ROWS constant must exist");
  assert.ok(defaultRowsMatch, "DEFAULT_ROWS constant must exist");
  const maxRows = Number(maxRowsMatch![1]);
  const defaultRows = Number(defaultRowsMatch![1]);
  assert.ok(maxRows <= 20, `MAX_ROWS (${maxRows}) must stay small — the model must never receive thousands of raw worker rows`);
  assert.ok(defaultRows <= maxRows, "DEFAULT_ROWS must not exceed MAX_ROWS");
  assert.match(src, /capLimit\(args\.limit, MAX_ROWS, DEFAULT_ROWS\)/, "the requested limit must be clamped through capLimit, never trusted directly");
});

test("find_current_workers supports cursor-based pagination for anything beyond the single-page cap", () => {
  const src = readSource();
  assert.match(src, /cursor/i, "must accept a cursor argument for paging");
  assert.match(src, /nextCursor/, "must return a nextCursor so the caller/model can page through a large result deterministically");
  assert.match(src, /gt\(employmentSessions\.id, args\.cursor\)/, "cursor must be applied as a keyset (gt) filter on a stable ordering column, not an offset");
});

test("find_current_workers never selects a raw PII column and never returns the fingerprint code value itself (boolean presence only)", () => {
  const src = readSource();
  for (const forbidden of [/\.cccd\b/, /\.phone\b/, /\.permanentAddress\b/, /\.residentialAddress\b/, /\.dob\b/]) {
    assert.doesNotMatch(src, forbidden, `must never select ${forbidden}`);
  }
  assert.match(src, /fingerprintCodePresent\s*=\s*!!row\.fingerprintCode/, "must derive fingerprint status as a boolean from the raw code, never pass the code itself through");
  assert.doesNotMatch(src, /workers\.push\(\{[\s\S]*?fingerprintCode\s*:\s*row\.fingerprintCode\b/, "the raw fingerprintCode value must not be placed directly on the returned WorkerDto");
});

test("find_current_workers reuses the canonical ACTIVE predicate — status APPROVED + end_date IS NULL + worker not deleted — never a second definition", () => {
  const src = readSource();
  assert.match(src, /eq\(employmentSessions\.status, "APPROVED"\)/);
  assert.match(src, /isNull\(employmentSessions\.endDate\)/);
  assert.match(src, /isNull\(workerProfiles\.deletedAt\)/);
});

test("find_current_workers has no generic SQL/raw-query parameter and is not named as a SQL escape hatch", () => {
  const src = readSource();
  assert.doesNotMatch(src, /execute_sql|run_query|raw_sql|db\.execute\(/i);
});
