import test from "node:test";
import assert from "node:assert/strict";
import { expandResetScopes, requiredConfirmationPhrase, RESET_DOMAIN_META } from "./scopes.ts";

test("IT_CODE: expands to the 3 NULL_COLUMNS mirror domains plus its own it_code_assignment_history table, never touches worker/employment rows", () => {
  const plan = expandResetScopes(["IT_CODE"]);
  assert.deepEqual(plan.effectiveScopes, ["IT_CODE"]);
  const keys = plan.domains.map((d) => d.key);
  assert.deepEqual(new Set(keys), new Set(["it_code_worker_profiles", "it_code_dw_data", "it_code_daily_applications", "it_code_assignment_history"]));
  assert.ok(!keys.includes("worker_profiles") && !keys.includes("employment_sessions") && !keys.includes("dw_data"), "IT_CODE must never delete worker/employment/dw_data rows");
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
  // NOT included: the standalone NULL_COLUMNS IT Code domains (subsumed by row deletion) and planning_tasks (factory-reset only).
  assert.ok(!keys.includes("it_code_worker_profiles"));
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
  const plan = expandResetScopes(["ALL_BUSINESS_DATA", "IT_CODE", "PLANNING"]);
  assert.deepEqual(plan.effectiveScopes, ["ALL_BUSINESS_DATA"]);
  const keys = plan.domains.map((d) => d.key);
  assert.ok(keys.includes("planning_tasks"));
  assert.ok(keys.includes("worker_profiles"));
  assert.ok(!keys.includes("it_code_worker_profiles"), "row deletion subsumes the column-null IT Code domains");
});

test("WORKFORCE requested alongside IT_CODE collapses to effectiveScopes=[WORKFORCE] (IT_CODE is redundant, not double-counted)", () => {
  const plan = expandResetScopes(["IT_CODE", "WORKFORCE"]);
  assert.deepEqual(plan.effectiveScopes, ["WORKFORCE"]);
});

test("Multiple independent non-subsuming scopes (IT_CODE + PLANNING) union their domains without duplication", () => {
  const plan = expandResetScopes(["IT_CODE", "PLANNING"]);
  assert.deepEqual(new Set(plan.effectiveScopes), new Set(["IT_CODE", "PLANNING"]));
  const keys = plan.domains.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length, "no duplicate domains");
  assert.ok(keys.includes("planning_allocations"));
  assert.ok(keys.includes("it_code_dw_data"));
});

test("Empty request produces an empty, safe plan", () => {
  const plan = expandResetScopes([]);
  assert.deepEqual(plan.domains, []);
  assert.deepEqual(plan.effectiveScopes, []);
});

test("requiredConfirmationPhrase: exact phrases per mission section 9", () => {
  assert.equal(requiredConfirmationPhrase(["IT_CODE"]), "RESET IT CODE");
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

/**
 * MISSION F2 section 23-24/252 — dw_code_locations (per-location prefix/sequence/config, the
 * mission recommends this SURVIVES a reset — same category as departments/organization_units)
 * must never appear as a reset domain's target table, in ANY scope, including ALL_BUSINESS_DATA.
 * `RESET_DOMAIN_META` is typed as `Record<ResetDomainKey, ResetDomainMeta>` (exhaustive over the
 * ResetDomainKey union) — this is a structural proof, not a snapshot of today's list: adding a new
 * domain that targets dw_code_locations would require both a new ResetDomainKey member AND wiring
 * it into some scope's domain set, so this test catches that the moment it happens, in any scope.
 * The pool's per-code ASSIGNED/AVAILABLE status (dw_code_pool_reset) DOES reset — only the
 * location/prefix/sequence CONFIGURATION survives — matching "worker data reset" without touching
 * "location config" (see the docblock above RESET_SCOPES in scopes.ts for the full rationale).
 */
test("dw_code_locations (location config) is never a reset-domain target table — dw_code_pool_reset only touches dw_codes' per-code status", () => {
  const tables = Object.values(RESET_DOMAIN_META).map((m) => m.table);
  assert.ok(!tables.includes("dw_code_locations"), "location/prefix/sequence config must survive every reset scope, including ALL_BUSINESS_DATA");
  assert.equal(RESET_DOMAIN_META.dw_code_pool_reset.table, "dw_codes");
  assert.equal(RESET_DOMAIN_META.dw_code_pool_reset.kind, "NULL_COLUMNS", "must reset per-code status in place, never DELETE_ALL_ROWS the pool's numbering rows");
});
