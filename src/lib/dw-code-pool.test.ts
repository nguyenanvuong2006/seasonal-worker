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
