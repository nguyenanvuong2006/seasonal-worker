import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDbWithTx, drizzleStub, makeTable, eqValue, argOf, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/**
 * MISSION E — IT Code assignment/release history (section 8, 22). Proves
 * against the real src/lib/it-code-assignment.ts: one active IT Code cannot
 * belong to two workers at once, a worker cannot hold two active IT Codes,
 * assign writes all 3 existing mirrors in the SAME transaction (dw_data,
 * worker_profiles, daily_applications — exactly what the pre-existing PATCH
 * /api/fingerprint/it-code handler already writes), and release is idempotent.
 */

const itCodeAssignments = makeTable("it_code_assignments");
const dwData = makeTable("dw_data");
const workerProfiles = makeTable("worker_profiles");
const dailyApplications = makeTable("daily_applications");
const schemaStub = { itCodeAssignments, dwData, workerProfiles, dailyApplications };

function makeStore(opts: {
  codeAlreadyActive?: boolean;
  workerAlreadyHasActive?: boolean;
  activeAssignment?: { id: string; itCode: string; dwDataId: string; workerId: string } | null;
  /** PRE-MIGRATION REVIEW #7 — dw_data.it_code mirror value for the legacy-compatibility fallback (no it_code_assignments row at all). */
  legacyMirrorItCode?: string | null;
}) {
  const writes: { table: string; patch: unknown }[] = [];
  const inserted: { table: string; values: unknown }[] = [];

  const respond = (call: QueryCall): unknown => {
    if (call.table === "it_code_assignments") {
      if (call.root === "select") {
        const itCodeEq = eqValue(call, "it_code_assignments.itCode");
        if (itCodeEq !== undefined) return opts.codeAlreadyActive ? [{ id: "assign-code" }] : [];
        const workerEq = eqValue(call, "it_code_assignments.workerId");
        if (workerEq !== undefined) return opts.workerAlreadyHasActive ? [{ id: "assign-worker" }] : [];
        // Release lookup by employmentSessionId.
        return opts.activeAssignment ? [opts.activeAssignment] : [];
      }
      if (call.root === "insert") {
        inserted.push({ table: "it_code_assignments", values: argOf(call, "values") });
        return [{ id: "assign-new" }];
      }
      if (call.root === "update") {
        writes.push({ table: "it_code_assignments", patch: argOf(call, "set") });
        return [{}];
      }
    }
    if (call.table === "dw_data") {
      if (call.root === "select") return opts.legacyMirrorItCode ? [{ itCode: opts.legacyMirrorItCode }] : [];
      if (call.root === "update") {
        writes.push({ table: "dw_data", patch: argOf(call, "set") });
        return [{}];
      }
    }
    if (call.table === "worker_profiles") {
      if (call.root === "select") return opts.activeAssignment || opts.legacyMirrorItCode ? [{ cccd: "001099001234" }] : [];
      if (call.root === "update") {
        writes.push({ table: "worker_profiles", patch: argOf(call, "set") });
        return [{}];
      }
    }
    if (call.table === "daily_applications" && call.root === "update") {
      writes.push({ table: "daily_applications", patch: argOf(call, "set") });
      return [{}];
    }
    return undefined;
  };

  const { db } = createFakeDbWithTx({ respond });
  return { db, writes, inserted };
}

async function loadWith(store: ReturnType<typeof makeStore>) {
  const mod = loadModule(new URL("./it-code-assignment.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db: store.db },
      "@/db/schema": schemaStub,
      "@/lib/dw-code-pool": {},
    },
  });
  return mod as unknown as {
    assignItCode: (input: Record<string, unknown>) => Promise<{ ok: true; assignmentId: string } | { ok: false; error: string }>;
    releaseItCode: (input: Record<string, unknown>) => Promise<{ released: boolean; itCode: string | null }>;
  };
}

const ASSIGN_INPUT = { itCode: "IT001", workerId: "w1", employmentSessionId: "s1", dwDataId: "dw1", dailyApplicationId: "app1", cccd: "001099001234", assignedBy: "staff1" };

test("assignItCode writes all 3 mirrors when both code and worker are free", async () => {
  const store = makeStore({});
  const mod = await loadWith(store);

  const result = await mod.assignItCode(ASSIGN_INPUT);

  assert.equal(result.ok, true);
  assert.equal(store.writes.some((w) => w.table === "dw_data" && (w.patch as Record<string, unknown>).itCode === "IT001"), true);
  assert.equal(store.writes.some((w) => w.table === "worker_profiles" && (w.patch as Record<string, unknown>).fingerprintCode === "IT001"), true);
  assert.equal(store.writes.some((w) => w.table === "daily_applications" && (w.patch as Record<string, unknown>).itCode === "IT001"), true);
});

test("assignItCode rejects when the IT Code is already active on another worker", async () => {
  const store = makeStore({ codeAlreadyActive: true });
  const mod = await loadWith(store);
  const result = await mod.assignItCode(ASSIGN_INPUT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "IT_CODE_ALREADY_ACTIVE");
});

test("assignItCode rejects when the worker already holds a different active IT Code", async () => {
  const store = makeStore({ workerAlreadyHasActive: true });
  const mod = await loadWith(store);
  const result = await mod.assignItCode(ASSIGN_INPUT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "WORKER_ALREADY_HAS_ACTIVE_IT_CODE");
});

test("releaseItCode clears all 3 mirrors and is idempotent when nothing is active", async () => {
  const activeAssignment = { id: "assign-1", itCode: "IT001", dwDataId: "dw1", workerId: "w1" };
  const store = makeStore({ activeAssignment });
  const mod = await loadWith(store);

  const result = await mod.releaseItCode({ employmentSessionId: "s1", dailyApplicationId: "app1", workerId: "w1", dwDataId: "dw1", releasedBy: "staff1", releaseReason: "NO_SHOW" });
  assert.equal(result.released, true);
  assert.equal(result.itCode, "IT001");
  assert.equal(store.writes.some((w) => w.table === "dw_data" && (w.patch as Record<string, unknown>).itCode === null), true);
  assert.equal(store.writes.some((w) => w.table === "worker_profiles" && (w.patch as Record<string, unknown>).fingerprintStatus === "CHUA_CAP"), true);

  const storeNoActive = makeStore({ activeAssignment: null });
  const modNoActive = await loadWith(storeNoActive);
  const noopResult = await modNoActive.releaseItCode({ employmentSessionId: "s-none", dailyApplicationId: "app1", workerId: "w-none", dwDataId: "dw-none", releasedBy: "staff1", releaseReason: "NO_SHOW" });
  assert.equal(noopResult.released, false);
  assert.equal(noopResult.itCode, null);
  assert.equal(storeNoActive.writes.length, 0);
});

/**
 * PRE-MIGRATION INDEPENDENT REVIEW (2026-09-13) — item #7: an IT Code assigned through the
 * legacy bulk PATCH /api/fingerprint/it-code screen (deliberately left untouched by this
 * mission) never writes an it_code_assignments history row. releaseItCode() must still clear
 * the mirrors correctly in that case via the dw_data fallback — never silently leave a departed
 * worker's IT Code mirror populated (which would cause the same external code, if reissued to a
 * different worker later, to disagree between the two workers' mirrors).
 */
test("legacy-assigned IT Code (no it_code_assignments row at all) is still correctly released via the dw_data mirror fallback", async () => {
  const store = makeStore({ activeAssignment: null, legacyMirrorItCode: "IT777" });
  const mod = await loadWith(store);

  const result = await mod.releaseItCode({ employmentSessionId: "s1", dailyApplicationId: "app1", workerId: "w1", dwDataId: "dw1", releasedBy: "staff1", releaseReason: "NO_SHOW" });

  assert.equal(result.released, true, "must NOT treat this as a no-op just because no history row exists");
  assert.equal(result.itCode, "IT777");
  assert.equal(store.writes.some((w) => w.table === "dw_data" && (w.patch as Record<string, unknown>).itCode === null), true);
  assert.equal(store.writes.some((w) => w.table === "worker_profiles" && (w.patch as Record<string, unknown>).fingerprintStatus === "CHUA_CAP"), true);
  assert.equal(store.writes.some((w) => w.table === "daily_applications" && (w.patch as Record<string, unknown>).itCode === null), true);
});

test("legacy fallback never fires when the dw_data mirror is already empty (nothing to release) and never fires without a dwDataId", async () => {
  const store = makeStore({ activeAssignment: null, legacyMirrorItCode: null });
  const mod = await loadWith(store);

  const result = await mod.releaseItCode({ employmentSessionId: "s1", dailyApplicationId: "app1", workerId: "w1", dwDataId: "dw1", releasedBy: "staff1", releaseReason: "NO_SHOW" });
  assert.equal(result.released, false);
  assert.equal(store.writes.length, 0);

  const result2 = await mod.releaseItCode({ employmentSessionId: "s1", dailyApplicationId: "app1", workerId: "w1", dwDataId: null, releasedBy: "staff1", releaseReason: "NO_SHOW" });
  assert.equal(result2.released, false);
});
