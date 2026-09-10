/**
 * AI COPILOT — structural proof for the four new Electronic Confirmation
 * deadline/history tools (2026-09-10 mission): get_electronic_confirmation_history,
 * get_pending_confirmations, get_expiring_confirmations,
 * get_expired_unconfirmed_documents. Same convention as
 * workers-drilldown.test.ts/read-only-audit.test.ts/privacy-audit.test.ts —
 * documents.ts imports "server-only" and touches the DB directly, so it is
 * proven structurally (source assertions) rather than executed.
 *
 * Asserts the mission's own non-negotiables:
 *   - Every tool re-resolves Data Scope from the session on every call.
 *   - A requested departmentId can only narrow, never widen, that scope.
 *   - Results are capped (MAX_CONFIRMATION_ROWS), never unbounded.
 *   - get_electronic_confirmation_history identifies the worker by workerId
 *     (UUID) — never by CCCD, matching find_current_workers' own convention
 *     (CCCD is never accepted as an AI-tool argument anywhere in this repo).
 *   - No generic execute_sql/raw-query tool was introduced alongside these.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCUMENTS_FILE = join(HERE, "documents.ts");

function readSource(): string {
  return readFileSync(DOCUMENTS_FILE, "utf8");
}

test("all four Electronic Confirmation tools are exported via documentTools", () => {
  const src = readSource();
  assert.match(src, /export const documentTools = \[[\s\S]*get_electronic_confirmation_history[\s\S]*get_pending_confirmations[\s\S]*get_expiring_confirmations[\s\S]*get_expired_unconfirmed_documents[\s\S]*\];/);
});

test("get_pending_confirmations / get_expiring_confirmations / get_expired_unconfirmed_documents each re-resolve Data Scope via getUserScope + intersectDepartmentFilter, never trusting a caller-supplied departmentId directly", () => {
  const src = readSource();
  const occurrences = src.match(/getUserScope\(ctx\.session\)/g) ?? [];
  // get_document_confirmation_summary (pre-existing) + the 3 new actionable tools = at least 4.
  assert.ok(occurrences.length >= 4, `expected getUserScope(ctx.session) in at least 4 tool executes, found ${occurrences.length}`);
  const intersectOccurrences = src.match(/intersectDepartmentFilter\(scope, args\.departmentId\)/g) ?? [];
  assert.ok(intersectOccurrences.length >= 4, `expected intersectDepartmentFilter(scope, args.departmentId) at least 4 times, found ${intersectOccurrences.length}`);
  assert.match(src, /FORBIDDEN/, "an out-of-scope departmentId must be rejected, never silently widen the scope");
});

test("the three actionable tools clamp their limit through capLimit against MAX_CONFIRMATION_ROWS, never trusting args.limit directly", () => {
  const src = readSource();
  const maxMatch = src.match(/const MAX_CONFIRMATION_ROWS = (\d+);/);
  assert.ok(maxMatch, "MAX_CONFIRMATION_ROWS constant must exist");
  assert.ok(Number(maxMatch![1]) <= 50, "MAX_CONFIRMATION_ROWS must stay small — never thousands of raw rows to the model");
  const capOccurrences = src.match(/capLimit\(args\.limit, MAX_CONFIRMATION_ROWS, MAX_CONFIRMATION_ROWS\)/g) ?? [];
  assert.equal(capOccurrences.length, 3, "each of the 3 actionable tools must clamp its own limit");
});

test("get_electronic_confirmation_history identifies the worker by workerId (UUID), never accepts a cccd argument — CCCD must never be an AI-tool input", () => {
  const src = readSource();
  assert.match(src, /workerId: \{ type: "string"/, "must declare a workerId parameter");
  assert.doesNotMatch(src, /properties:\s*\{\s*cccd:/, "must never declare a raw cccd input parameter for any tool");
  assert.doesNotMatch(src, /args\.cccd\b/, "must never read args.cccd");
});

test("get_electronic_confirmation_history applies its own Data Scope filter (deptId intersection) on the returned history, not just a blanket allow", () => {
  const src = readSource();
  const start = src.indexOf("const get_electronic_confirmation_history");
  const end = src.indexOf("\n};", start);
  const fnBody = src.slice(start, end);
  assert.match(fnBody, /getUserScope\(ctx\.session\)/);
  assert.match(fnBody, /scope\.includes\(deptId\)/, "must intersect returned rows against the caller's own scope, never trust the history blindly");
});

test("get_expiring_confirmations clamps withinHours through capLimit against a bounded MAX_EXPIRING_WINDOW_HOURS", () => {
  const src = readSource();
  assert.match(src, /const MAX_EXPIRING_WINDOW_HOURS = /);
  assert.match(src, /capLimit\(args\.withinHours, MAX_EXPIRING_WINDOW_HOURS, DEFAULT_EXPIRING_WINDOW_HOURS\)/);
});

test("no new execute_sql/run_query/raw_sql tool name was introduced alongside the 4 new tools", () => {
  const src = readSource();
  assert.doesNotMatch(src, /name:\s*"execute_sql"/);
  assert.doesNotMatch(src, /name:\s*"run_query"/);
  assert.doesNotMatch(src, /name:\s*"raw_sql"/);
});

test("applicant names returned by the 3 actionable tools are routed through normalizePersonName, matching movements.ts/workers.ts's own name-formatting convention", () => {
  const src = readSource();
  assert.match(src, /import \{ normalizePersonName \} from "@\/lib\/person-name";/);
  assert.match(src, /function withNormalizedNames/);
  const withNormalizedCalls = src.match(/withNormalizedNames\(await get(Pending|Expiring|ExpiredUnconfirmed)/g) ?? [];
  assert.equal(withNormalizedCalls.length, 3, "each of the 3 actionable tools must route its rows through withNormalizedNames");
});
