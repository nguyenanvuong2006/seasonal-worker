import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDbWithTx, drizzleStub, makeTable, eqValue, argOf, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/**
 * MISSION E — Internal DW Code pool (sections 4-7, 48-51). Proves against the
 * real src/lib/dw-code-pool.ts:
 *   - reuse policy: a released AVAILABLE code is reused BEFORE a new sequence
 *     number is ever consumed (never `MAX(code)+1`, never skips a free slot);
 *   - a brand-new sequence number is only consumed when no AVAILABLE code exists;
 *   - one active code per worker is enforced (WORKER_ALREADY_HAS_ACTIVE_CODE);
 *   - LOCATION_NOT_FOUND / LOCATION_INACTIVE guard rails;
 *   - releaseDwCode flips the code back to AVAILABLE, clears the dw_data.code
 *     mirror, and is idempotent (no active assignment = safe no-op, never an error).
 */

const dwCodeLocations = makeTable("dw_code_locations");
const dwCodes = makeTable("dw_codes");
const dwCodeAssignments = makeTable("dw_code_assignments");
const dwData = makeTable("dw_data");
const schemaStub = { dwCodeLocations, dwCodes, dwCodeAssignments, dwData };

const LOCATION = { id: "loc-1", prefix: "DR", sequenceDigits: 5, separator: "-", suffix: "D", nextSequence: 7, isActive: true };

function makeStore(opts: {
  location?: typeof LOCATION | null;
  workerHasActive?: boolean;
  reusableCode?: { id: string; code: string; sequenceNumber: number } | null;
}) {
  const writes: { table: string; patch: unknown }[] = [];
  const inserted: { table: string; values: unknown }[] = [];

  const respond = (call: QueryCall): unknown => {
    if (call.table === "dw_code_locations") {
      if (call.root === "select") return opts.location === undefined ? [LOCATION] : opts.location ? [opts.location] : [];
      if (call.root === "update") {
        const patch = argOf(call, "set");
        writes.push({ table: "dw_code_locations", patch });
        // Simulates `UPDATE ... SET next_sequence = next_sequence + 1 RETURNING next_sequence - 1`
        // — the pre-update value is what actually gets used as the sequence number.
        return [{ usedSequence: (opts.location ?? LOCATION).nextSequence }];
      }
    }
    if (call.table === "dw_code_assignments") {
      if (call.root === "select") {
        const workerEq = eqValue(call, "dw_code_assignments.workerId");
        if (workerEq !== undefined) return opts.workerHasActive ? [{ id: "assign-existing" }] : [];
        // Release lookup by employmentSessionId — no reusable-assignment test needs a hit here.
        return [];
      }
      if (call.root === "insert") {
        inserted.push({ table: "dw_code_assignments", values: argOf(call, "values") });
        return [{}];
      }
    }
    if (call.table === "dw_codes") {
      if (call.root === "select") return opts.reusableCode ? [opts.reusableCode] : [];
      if (call.root === "update") {
        const patch = argOf(call, "set");
        writes.push({ table: "dw_codes", patch });
        return [{ code: opts.reusableCode?.code ?? "DR00007-D" }];
      }
      if (call.root === "insert") {
        inserted.push({ table: "dw_codes", values: argOf(call, "values") });
        return [{ id: "code-new" }];
      }
    }
    if (call.table === "dw_data" && call.root === "update") {
      writes.push({ table: "dw_data", patch: argOf(call, "set") });
      return [{}];
    }
    return undefined;
  };

  const { db } = createFakeDbWithTx({ respond });
  return { db, writes, inserted };
}

async function loadWith(store: ReturnType<typeof makeStore>) {
  const mod = loadModule(new URL("./dw-code-pool.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db: store.db },
      "@/db/schema": schemaStub,
    },
  });
  return mod as unknown as {
    formatDwCode: (config: { prefix: string; sequenceDigits: number; separator: string; suffix: string }, n: number) => string;
    previewDwCode: (config: { prefix: string; sequenceDigits: number; separator: string; suffix: string }, n: number) => string;
    allocateDwCode: (input: Record<string, unknown>) => Promise<{ ok: true; code: string; codeId: string; reused: boolean } | { ok: false; error: string }>;
    releaseDwCode: (input: Record<string, unknown>) => Promise<{ released: boolean; code: string | null }>;
  };
}

test("formatDwCode/previewDwCode produce the exact configured pattern", async () => {
  const store = makeStore({});
  const mod = await loadWith(store);
  assert.equal(mod.formatDwCode({ prefix: "DR", sequenceDigits: 5, separator: "-", suffix: "D" }, 1), "DR00001-D");
  assert.equal(mod.previewDwCode({ prefix: "DL", sequenceDigits: 5, separator: "-", suffix: "D" }, 42), "DL00042-D");
});

test("allocateDwCode reuses an AVAILABLE released code before consuming a new sequence number", async () => {
  const reusable = { id: "code-old", code: "DR00003-D", sequenceNumber: 3 };
  const store = makeStore({ reusableCode: reusable });
  const mod = await loadWith(store);

  const result = await mod.allocateDwCode({ locationId: "loc-1", workerId: "w1", employmentSessionId: "s1", dwDataId: "dw1", assignedBy: "hr1" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reused, true);
  assert.equal(result.code, "DR00003-D");
  assert.equal(store.writes.some((w) => w.table === "dw_code_locations"), false, "reuse path must NOT consume the location's sequence counter");
  const codeUpdate = store.writes.find((w) => w.table === "dw_codes");
  assert.equal((codeUpdate?.patch as Record<string, unknown>)?.status, "ASSIGNED");
});

test("allocateDwCode consumes the next sequence number when no AVAILABLE code exists", async () => {
  const store = makeStore({ reusableCode: null });
  const mod = await loadWith(store);

  const result = await mod.allocateDwCode({ locationId: "loc-1", workerId: "w1", employmentSessionId: "s1", dwDataId: "dw1", assignedBy: "hr1" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reused, false);
  assert.equal(result.code, "DR00007-D", "must use the PRE-update sequence value (7), never the post-increment value");
  const newCodeInsert = store.inserted.find((i) => i.table === "dw_codes");
  assert.ok(newCodeInsert);
});

test("allocateDwCode rejects a worker who already has an active code", async () => {
  const store = makeStore({ workerHasActive: true });
  const mod = await loadWith(store);
  const result = await mod.allocateDwCode({ locationId: "loc-1", workerId: "w1", employmentSessionId: "s1", dwDataId: "dw1", assignedBy: "hr1" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "WORKER_ALREADY_HAS_ACTIVE_CODE");
});

test("allocateDwCode rejects an unknown or inactive location", async () => {
  const storeMissing = makeStore({ location: null });
  const modMissing = await loadWith(storeMissing);
  const missingResult = await modMissing.allocateDwCode({ locationId: "loc-x", workerId: "w1", employmentSessionId: "s1", dwDataId: "dw1", assignedBy: "hr1" });
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.equal(missingResult.error, "LOCATION_NOT_FOUND");

  const storeInactive = makeStore({ location: { ...LOCATION, isActive: false } });
  const modInactive = await loadWith(storeInactive);
  const inactiveResult = await modInactive.allocateDwCode({ locationId: "loc-1", workerId: "w1", employmentSessionId: "s1", dwDataId: "dw1", assignedBy: "hr1" });
  assert.equal(inactiveResult.ok, false);
  if (!inactiveResult.ok) assert.equal(inactiveResult.error, "LOCATION_INACTIVE");
});

test("releaseDwCode is idempotent when no active assignment exists for the session", async () => {
  const store = makeStore({});
  const mod = await loadWith(store);
  const result = await mod.releaseDwCode({ employmentSessionId: "s-none", releasedBy: "hr1", releaseReason: "NO_SHOW" });
  assert.equal(result.released, false);
  assert.equal(result.code, null);
  assert.equal(store.writes.length, 0);
});

/**
 * MISSION F2 section 25-26/253 — SELF-SERVICE ISOLATION SECURITY REGRESSION. Code reuse (a
 * released code being handed to a NEW worker, the exact scenario "allocateDwCode reuses an
 * AVAILABLE released code" above proves happens) must NEVER let the new holder's active
 * assignment be conflated with the departed worker's identity or history. A stateful in-memory
 * model (not static per-call responses) so real release-THEN-reuse sequencing is exercised end to
 * end against the REAL releaseDwCode()/allocateDwCode(), exactly like workforce-movements-cross-
 * location.test.ts does for the transfer flow.
 */
test("SECURITY — a released code reused by a new worker never leaks or overwrites the departed worker's assignment row/identity", async () => {
  const location = { id: "loc-1", prefix: "DR", sequenceDigits: 5, separator: "-", suffix: "D", nextSequence: 9, isActive: true };
  const codes = new Map([["code-1", { id: "code-1", locationId: "loc-1", sequenceNumber: 3, code: "DR00003-D", status: "ASSIGNED" }]]);
  const assignments = new Map([
    ["assign-A", { id: "assign-A", codeId: "code-1", workerId: "worker-A", employmentSessionId: "sess-A", dwDataId: "dw-A", assignedBy: "hr1", releasedAt: null as Date | null, releasedBy: null as string | null, releaseReason: null as string | null }],
  ]);
  const dws = new Map([
    ["dw-A", { id: "dw-A", code: "DR00003-D" }],
    ["dw-B", { id: "dw-B", code: null as string | null }],
  ]);
  let nextAssignmentId = 1;

  const respond = (call: QueryCall): unknown => {
    if (call.table === "dw_code_locations") {
      if (call.root === "select") return [location];
    }
    if (call.table === "dw_code_assignments") {
      if (call.root === "select") {
        const empSessEq = eqValue(call, "dw_code_assignments.employmentSessionId");
        if (empSessEq !== undefined) {
          const active = [...assignments.values()].find((a) => a.employmentSessionId === empSessEq && a.releasedAt === null);
          return active ? [active] : [];
        }
        const workerEq = eqValue(call, "dw_code_assignments.workerId");
        if (workerEq !== undefined) {
          const active = [...assignments.values()].find((a) => a.workerId === workerEq && a.releasedAt === null);
          return active ? [{ id: active.id }] : [];
        }
        return [];
      }
      if (call.root === "insert") {
        const values = argOf(call, "values") as Record<string, unknown>;
        const id = `assign-new-${nextAssignmentId++}`;
        assignments.set(id, { id, codeId: values.codeId as string, workerId: values.workerId as string, employmentSessionId: values.employmentSessionId as string, dwDataId: values.dwDataId as string, assignedBy: values.assignedBy as string, releasedAt: null, releasedBy: null, releaseReason: null });
        return [{}];
      }
      if (call.root === "update") {
        const idEq = eqValue(call, "dw_code_assignments.id") as string;
        const patch = argOf(call, "set") as Record<string, unknown>;
        const existing = assignments.get(idEq);
        if (existing) Object.assign(existing, patch);
        return [{}];
      }
    }
    if (call.table === "dw_codes") {
      if (call.root === "select") {
        const available = [...codes.values()].find((c) => c.locationId === "loc-1" && c.status === "AVAILABLE");
        return available ? [available] : [];
      }
      if (call.root === "update") {
        const idEq = eqValue(call, "dw_codes.id") as string;
        const patch = argOf(call, "set") as Record<string, unknown>;
        const code = codes.get(idEq);
        if (code) Object.assign(code, patch);
        return [{ code: code?.code ?? null }];
      }
    }
    if (call.table === "dw_data" && call.root === "update") {
      const idEq = eqValue(call, "dw_data.id") as string;
      const patch = argOf(call, "set") as Record<string, unknown>;
      const dw = dws.get(idEq);
      if (dw) Object.assign(dw, patch);
      return [{}];
    }
    return undefined;
  };

  const { db } = createFakeDbWithTx({ respond });
  const mod = loadModule(new URL("./dw-code-pool.ts", import.meta.url), {
    stubs: { "server-only": serverOnlyStub, "drizzle-orm": drizzleStub, "@/db": { db }, "@/db/schema": schemaStub },
  }) as unknown as {
    allocateDwCode: (input: Record<string, unknown>) => Promise<{ ok: true; code: string; codeId: string; reused: boolean } | { ok: false; error: string }>;
    releaseDwCode: (input: Record<string, unknown>) => Promise<{ released: boolean; code: string | null }>;
  };

  // Worker A departs — their DW code is released.
  const releaseResult = await mod.releaseDwCode({ employmentSessionId: "sess-A", releasedBy: "hr1", releaseReason: "EMPLOYMENT_ENDED" });
  assert.equal(releaseResult.released, true);
  assert.equal(releaseResult.code, "DR00003-D");
  const originalAssignment = assignments.get("assign-A")!;
  assert.ok(originalAssignment.releasedAt, "A's own history row must record the release");
  assert.equal(originalAssignment.workerId, "worker-A", "A's history row must never change owner");

  // Worker B is now assigned the SAME code (reuse).
  const allocateResult = await mod.allocateDwCode({ locationId: "loc-1", workerId: "worker-B", employmentSessionId: "sess-B", dwDataId: "dw-B", assignedBy: "hr1" });
  assert.equal(allocateResult.ok, true);
  if (!allocateResult.ok) return;
  assert.equal(allocateResult.reused, true, "must reuse the just-released code, never mint a new sequence while one is AVAILABLE");
  assert.equal(allocateResult.code, "DR00003-D");

  // A's history row must be COMPLETELY UNTOUCHED by B's allocation — still exactly 2 distinct rows.
  assert.equal(assignments.size, 2, "reuse must INSERT a new assignment row, never UPDATE/overwrite A's row");
  const aRow = assignments.get("assign-A")!;
  assert.equal(aRow.workerId, "worker-A", "A's row must still say A, never silently become B after reuse");
  assert.ok(aRow.releasedAt, "A's row must remain released — reuse must not un-release it");

  const bRow = [...assignments.values()].find((a) => a.id !== "assign-A")!;
  assert.equal(bRow.workerId, "worker-B");
  assert.equal(bRow.releasedAt, null, "B's row must be the only ACTIVE (releasedAt IS NULL) row for this code");

  // "Who currently holds this code" must resolve to EXACTLY B — never both, never A.
  const currentHolders = [...assignments.values()].filter((a) => a.codeId === "code-1" && a.releasedAt === null);
  assert.equal(currentHolders.length, 1, "exactly one current holder — the query pattern every real lookup (diagnostic script, activation planner, pool status) uses");
  assert.equal(currentHolders[0].workerId, "worker-B");

  // dw_data mirrors: A's old mirror was cleared by releaseDwCode; B's new mirror reflects the code.
  assert.equal(dws.get("dw-A")!.code, null, "A's dw_data mirror must be cleared on release, never left showing a code A no longer holds");
  assert.equal(dws.get("dw-B")!.code, "DR00003-D");
});
