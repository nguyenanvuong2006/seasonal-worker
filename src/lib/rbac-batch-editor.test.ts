import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBulk,
  buildBatchChanges,
  computeChangedKeys,
  effectiveAllowed,
  resetToBaseline,
  shouldConfirmDiscard,
  toggleOne,
  type PermissionMap,
} from "./rbac-batch-editor.ts";

function mapOf(entries: [string, boolean][]): PermissionMap {
  return new Map(entries);
}

test("effectiveAllowed: fail-closed — a key absent from the map is false", () => {
  assert.equal(effectiveAllowed(new Map(), "dw.view"), false);
  assert.equal(effectiveAllowed(mapOf([["dw.view", true]]), "dw.view"), true);
  assert.equal(effectiveAllowed(mapOf([["dw.view", false]]), "dw.view"), false);
});

/* ------------------------------------------------------------------ *
 * 1 — toggling many permissions is pure local state: no writes, and
 * changedKeys reflects EXACTLY what was toggled.
 * ------------------------------------------------------------------ */

test("toggleOne: never mutates the input map (pure), only flips the given key", () => {
  const baseline = mapOf([["dw.view", false]]);
  const after = toggleOne(baseline, "dw.view");
  assert.equal(baseline.get("dw.view"), false, "input map must not be mutated");
  assert.equal(after.get("dw.view"), true);
});

test("toggling 20 different permissions produces 20 changed keys and zero side effects (pure function, no I/O)", () => {
  const baseline: PermissionMap = new Map();
  let draft: PermissionMap = new Map();
  const keys = Array.from({ length: 20 }, (_, i) => `group.permission_${i}`);
  for (const k of keys) draft = toggleOne(draft, k);
  const changed = computeChangedKeys(baseline, draft);
  assert.equal(changed.length, 20);
  assert.deepEqual(changed, [...keys].sort());
});

test("toggling a key back to its original value removes it from changedKeys (round-trip)", () => {
  const baseline = mapOf([["dw.view", false]]);
  let draft = toggleOne(baseline, "dw.view"); // -> true, dirty
  assert.equal(computeChangedKeys(baseline, draft).length, 1);
  draft = toggleOne(draft, "dw.view"); // -> false, matches baseline again
  assert.equal(computeChangedKeys(baseline, draft).length, 0);
});

/* ------------------------------------------------------------------ *
 * 5 — Cancel restores the original state exactly.
 * ------------------------------------------------------------------ */

test("resetToBaseline: restores an independent copy identical to baseline, clearing all dirty state", () => {
  const baseline = mapOf([
    ["dw.view", true],
    ["meal.view", false],
  ]);
  let draft = toggleOne(baseline, "dw.view");
  draft = toggleOne(draft, "meal.view");
  assert.equal(computeChangedKeys(baseline, draft).length, 2);

  const restored = resetToBaseline(baseline);
  assert.equal(computeChangedKeys(baseline, restored).length, 0);
  assert.notEqual(restored, baseline, "must be a fresh copy, not the same reference");
});

/* ------------------------------------------------------------------ *
 * 7 — the "0 pending changes" state this drives the Save button off of.
 * ------------------------------------------------------------------ */

test("computeChangedKeys: an untouched draft (identical map instance or a fresh copy) has zero changes", () => {
  const baseline = mapOf([["dw.view", true]]);
  assert.equal(computeChangedKeys(baseline, baseline).length, 0);
  assert.equal(computeChangedKeys(baseline, new Map(baseline)).length, 0);
});

/* ------------------------------------------------------------------ *
 * 11 — bulk enable/disable safety net: protected keys are excluded from
 * a blanket enable, but disable and individual toggle are unaffected.
 * ------------------------------------------------------------------ */

test("applyBulk: enabling a set that includes protected keys excludes them and reports which", () => {
  const protectedKeys = new Set(["rbac.manage", "users.manage"]);
  const { next, excluded } = applyBulk(new Map(), ["dw.view", "rbac.manage", "meal.view", "users.manage"], true, protectedKeys);
  assert.deepEqual(excluded.sort(), ["rbac.manage", "users.manage"]);
  assert.equal(next.get("dw.view"), true);
  assert.equal(next.get("meal.view"), true);
  assert.equal(next.has("rbac.manage"), false, "protected key must not be silently enabled");
  assert.equal(next.has("users.manage"), false);
});

test("applyBulk: disabling NEVER excludes protected keys — revoking is always safe", () => {
  const protectedKeys = new Set(["rbac.manage"]);
  const draft = new Map([["rbac.manage", true]]);
  const { next, excluded } = applyBulk(draft, ["rbac.manage", "dw.view"], false, protectedKeys);
  assert.deepEqual(excluded, []);
  assert.equal(next.get("rbac.manage"), false);
  assert.equal(next.get("dw.view"), false);
});

test("applyBulk: an admin can still grant a protected key individually via toggleOne — the exclusion only applies to blanket bulk actions", () => {
  const draft = toggleOne(new Map(), "rbac.manage");
  assert.equal(draft.get("rbac.manage"), true, "individual toggle is never blocked, only the bulk sweep excludes it");
});

test("applyBulk never mutates the input map", () => {
  const draft: PermissionMap = new Map([["dw.view", false]]);
  applyBulk(draft, ["dw.view"], true, new Set());
  assert.equal(draft.get("dw.view"), false, "input must remain untouched");
});

/* ------------------------------------------------------------------ *
 * buildBatchChanges — exactly what gets sent to the server.
 * ------------------------------------------------------------------ */

test("buildBatchChanges: contains exactly the changed keys with their new values, nothing unchanged", () => {
  const baseline = mapOf([
    ["dw.view", false],
    ["meal.view", true],
    ["fingerprint.view", false],
  ]);
  let draft = toggleOne(baseline, "dw.view"); // false -> true
  draft = toggleOne(draft, "meal.view"); // true -> false
  // fingerprint.view left untouched
  const changes = buildBatchChanges(baseline, draft);
  assert.deepEqual(
    changes.sort((a, b) => a.permissionKey.localeCompare(b.permissionKey)),
    [
      { permissionKey: "dw.view", allowed: true },
      { permissionKey: "meal.view", allowed: false },
    ],
  );
});

test("buildBatchChanges: zero changes produces an empty array", () => {
  const baseline = mapOf([["dw.view", true]]);
  assert.deepEqual(buildBatchChanges(baseline, new Map(baseline)), []);
});

/* ------------------------------------------------------------------ *
 * 6 — switching role (or tab) with dirty state warns before discard;
 * a clean editor never interferes with normal navigation.
 * ------------------------------------------------------------------ */

test("shouldConfirmDiscard: warns when switching to a DIFFERENT role/tab while dirty", () => {
  assert.equal(shouldConfirmDiscard("ADMINISTRATION", "HR_RECRUITER", true), true);
  assert.equal(shouldConfirmDiscard("roles", "matrix", true), true);
});

test("shouldConfirmDiscard: never warns when there is nothing dirty — does not interfere with normal navigation", () => {
  assert.equal(shouldConfirmDiscard("ADMINISTRATION", "HR_RECRUITER", false), false);
  assert.equal(shouldConfirmDiscard("roles", "matrix", false), false);
});

test("shouldConfirmDiscard: re-selecting the SAME role/tab is a no-op, never a confirmation, even while dirty", () => {
  assert.equal(shouldConfirmDiscard("ADMINISTRATION", "ADMINISTRATION", true), false);
  assert.equal(shouldConfirmDiscard("matrix", "matrix", true), false);
});
