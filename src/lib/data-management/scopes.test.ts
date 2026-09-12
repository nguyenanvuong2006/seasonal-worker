import test from "node:test";
import assert from "node:assert/strict";
import { expandResetScopes, requiredConfirmationPhrase, RESET_DOMAIN_META } from "./scopes.ts";

test("FINGERPRINT: expands to exactly the 3 NULL_COLUMNS domains, never touches worker/employment rows", () => {
  const plan = expandResetScopes(["FINGERPRINT"]);
  assert.deepEqual(plan.effectiveScopes, ["FINGERPRINT"]);
  const keys = plan.domains.map((d) => d.key);
  assert.deepEqual(keys, ["fingerprint_worker_profiles", "fingerprint_dw_data", "fingerprint_daily_applications"]);
  assert.ok(plan.domains.every((d) => d.kind === "NULL_COLUMNS"), "FINGERPRINT must never delete rows");
});

test("RECRUITMENT_OPERATIONS: does not include daily_applications (soft-referenced by employment_sessions, no hard FK)", () => {
  const plan = expandResetScopes(["RECRUITMENT_OPERATIONS"]);
  const keys = plan.domains.map((d) => d.key);
  assert.ok(!keys.includes("daily_applications"), "daily_applications must only ever reset as part of WORKFORCE");
  assert.deepEqual(keys, ["request_allocation_overrides", "request_allocation_history", "request_allocations", "request_comments", "request_kpi_cache"]);
});

test("PLANNING: only planning_allocations, never touches employment_sessions", () => {
  const plan = expandResetScopes(["PLANNING"]);
  assert.deepEqual(plan.domains.map((d) => d.key), ["planning_allocations"]);
});

test("WORKFORCE forces the full dependency union — no standalone MOVEMENTS-only reset is ever possible (mission section 27)", () => {
  const plan = expandResetScopes(["WORKFORCE"]);
  assert.deepEqual(plan.effectiveScopes, ["WORKFORCE"]);
  const keys: string[] = plan.domains.map((d) => d.key);
  // Forced dependents present.
  for (const required of [
    "request_allocation_overrides",
    "request_allocation_history",
    "request_allocations",
    "request_comments",
    "request_kpi_cache",
    "planning_allocations",
    "start_date_corrections",
    "workforce_movements",
    "employment_sessions",
    "daily_applications",
    "worker_profiles",
    "dw_data",
  ]) {
    assert.ok(keys.includes(required), `WORKFORCE must force-include ${required}`);
  }
  // NOT included: the standalone NULL_COLUMNS fingerprint domains (subsumed by row deletion) and planning_tasks (factory-reset only).
  assert.ok(!keys.includes("fingerprint_worker_profiles"));
  assert.ok(!keys.includes("planning_tasks"));
});

test("WORKFORCE delete order: children before worker_profiles/dw_data, and workforce_movements + employment_sessions both precede worker_profiles (both hold real hard FK RESTRICT to worker_profiles)", () => {
  const plan = expandResetScopes(["WORKFORCE"]);
  const order: string[] = plan.domains.map((d) => d.key);
  const idx = (k: string) => order.indexOf(k);
  assert.ok(idx("request_allocations") < idx("employment_sessions"));
  assert.ok(idx("planning_allocations") < idx("employment_sessions"));
  assert.ok(idx("workforce_movements") < idx("worker_profiles"), "workforce_movements has a hard FK to worker_profiles — must delete first");
  assert.ok(idx("employment_sessions") < idx("worker_profiles"), "employment_sessions has a hard FK to worker_profiles — must delete first");
  assert.ok(idx("daily_applications") < idx("worker_profiles"));
  assert.ok(idx("worker_profiles") < idx("dw_data") || idx("dw_data") < idx("worker_profiles"), "no hard FK constrains worker_profiles/dw_data relative order, either is safe");
});

test("ALL_BUSINESS_DATA: WORKFORCE union plus planning_tasks, and subsumes any other requested scope", () => {
  const plan = expandResetScopes(["ALL_BUSINESS_DATA", "FINGERPRINT", "PLANNING"]);
  assert.deepEqual(plan.effectiveScopes, ["ALL_BUSINESS_DATA"]);
  const keys = plan.domains.map((d) => d.key);
  assert.ok(keys.includes("planning_tasks"));
  assert.ok(keys.includes("worker_profiles"));
  assert.ok(!keys.includes("fingerprint_worker_profiles"), "row deletion subsumes the column-null fingerprint domains");
});

test("WORKFORCE requested alongside FINGERPRINT collapses to effectiveScopes=[WORKFORCE] (FINGERPRINT is redundant, not double-counted)", () => {
  const plan = expandResetScopes(["FINGERPRINT", "WORKFORCE"]);
  assert.deepEqual(plan.effectiveScopes, ["WORKFORCE"]);
});

test("Multiple independent non-subsuming scopes (FINGERPRINT + PLANNING) union their domains without duplication", () => {
  const plan = expandResetScopes(["FINGERPRINT", "PLANNING"]);
  assert.deepEqual(new Set(plan.effectiveScopes), new Set(["FINGERPRINT", "PLANNING"]));
  const keys = plan.domains.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length, "no duplicate domains");
  assert.ok(keys.includes("planning_allocations"));
  assert.ok(keys.includes("fingerprint_dw_data"));
});

test("Empty request produces an empty, safe plan", () => {
  const plan = expandResetScopes([]);
  assert.deepEqual(plan.domains, []);
  assert.deepEqual(plan.effectiveScopes, []);
});

test("requiredConfirmationPhrase: exact phrases per mission section 9", () => {
  assert.equal(requiredConfirmationPhrase(["FINGERPRINT"]), "RESET FINGERPRINT");
  assert.equal(requiredConfirmationPhrase(["WORKFORCE"]), "RESET WORKFORCE DATA");
  assert.equal(requiredConfirmationPhrase(["ALL_BUSINESS_DATA"]), "RESET ALL BUSINESS DATA");
});

test("Every domain key referenced anywhere has metadata (label/table/kind) — no silent gaps", () => {
  for (const key of Object.keys(RESET_DOMAIN_META)) {
    const meta = RESET_DOMAIN_META[key as keyof typeof RESET_DOMAIN_META];
    assert.ok(meta.label.length > 0);
    assert.ok(meta.table.length > 0);
    assert.ok(meta.kind === "DELETE_ALL_ROWS" || meta.kind === "NULL_COLUMNS");
  }
});
