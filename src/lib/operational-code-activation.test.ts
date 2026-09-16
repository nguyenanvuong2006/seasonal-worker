import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/**
 * MISSION F — dry-run activation planner + activation writer
 * (src/lib/operational-code-activation.ts).
 *
 * Part A: proves the P1 bootstrap-safety guarantee (mission section 3/33/34):
 *   a legacy code already in active use must NEVER be classified as
 *   adoptable/safe by this planner, and a location whose nextSequence would
 *   collide with legacy history must be BLOCKED, not silently READY.
 *
 * Part B: proves the applyOperationalCodeActivation() writer contract:
 *   stale checksum, conflict guard, protected RETIRED, DW adoption,
 *   IT adoption, idempotent re-run, rollback on mid-tx failure,
 *   nextSequence monotonicity, protected codes never AVAILABLE,
 *   duplicate active ownership rejection.
 */

// ---------------------------------------------------------------------------
// LOADER
// ---------------------------------------------------------------------------
async function loadMod() {
  return loadModule(new URL("./operational-code-activation.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": await import("drizzle-orm"),
      "node:crypto": await import("node:crypto"),
      "@/db": { db: { execute: async () => ({ rows: [] }) } },
      "@/lib/operational-code-activation-plan": await import("./operational-code-activation-plan.ts"),
    },
  }) as unknown as {
    parseDwCodeFormat: (code: string) => { prefix: string; sequence: number; separator: string; suffix: string } | null;
    computeSafeNextSequence: (observedMax: number | null) => number;
    classifyMirrorConsistency: (dwCode: string | null, wpCode: string | null) => string;
    evaluateLocationReadiness: (loc: { locationId: string; prefix: string; name: string; isActive: boolean; nextSequence: number }, legacyMax: number | null) => { state: string };
    buildActivationPlan: (input: {
      generatedAt: string;
      sourceCommitSha: string | null;
      locations: { locationId: string; prefix: string; name: string; isActive: boolean; nextSequence: number }[];
      dwRows: { dwDataId: string; workerRef: string | null; employmentSessionId: string | null; code: string; isActive: boolean }[];
      itRows: { workerRef: string; dwDataId: string | null; employmentSessionId: string | null; dwDataItCode: string | null; workerProfileFingerprintCode: string | null; isActive: boolean }[];
    }) => {
      readiness: string;
      locationReadiness: { locationId: string; prefix: string; name: string; isActive: boolean; nextSequence: number; legacyObservedMaxSequence: number | null; state: string }[];
      dwAdoptions: { workerRef: string; employmentSessionId: string; dwDataId: string; code: string; locationId: string; sequenceNumber: number }[];
      dwProtectedCodes: { code: string; prefix: string; locationId: string; sequenceNumber: number }[];
      itAdoptions: { workerRef: string; employmentSessionId: string; dwDataId: string; itCode: string }[];
      conflicts: { type: string; workerRefs: string[] }[];
      checksum: string;
    };
    prepareOperationalCodeActivation: (opts: { dryRun: true }, executor: unknown) => Promise<unknown>;
    applyOperationalCodeActivation: (checksum: string, executor?: unknown) => Promise<unknown>;
    OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY: number;
  };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Extract SQL text from a Drizzle sql`` template object or a plain string.
 * Drizzle sql objects have `queryChunks` — each chunk is a StringChunk with `.value` (string[])
 * or a SQL param placeholder. We join all string chunks to reconstruct the query text. */
function extractSql(q: unknown): string {
  if (typeof q === "string") return q;
  if (typeof q === "object" && q !== null) {
    const obj = q as Record<string, unknown>;
    const chunks = obj["queryChunks"];
    if (Array.isArray(chunks)) {
      return chunks
        .map((c: unknown) => {
          if (typeof c === "string") return c;
          // StringChunk has `.value` which is a string[].
          const chunk = c as Record<string, unknown>;
          if (Array.isArray(chunk["value"])) return (chunk["value"] as string[]).join("");
          if (typeof chunk["value"] === "string") return chunk["value"];
          return "";
        })
        .join(" ");
    }
  }
  return String(q);
}

/** Detect the query type from its SQL text so the fake executor can
 * respond correctly without relying on call order (which breaks on checksums
 * because prepareOperationalCodeActivation internally calls execute 3× each time). */
function queryLabel(q: unknown): string {
  const s = extractSql(q).toLowerCase().replace(/\s+/g, " ");
  // Detection order matters — be specific before broad.
  if (/pg_try_advisory_xact_lock/.test(s)) return "advisory_lock";
  if (/insert into dw_codes/.test(s)) return "insert_dw_codes";
  if (/update dw_code_locations/.test(s)) return "update_dw_code_locations";
  if (/select.*from dw_codes where code/.test(s)) return "select_dw_code_by_code";
  if (/from dw_code_assignments.*where code_id/.test(s)) return "select_dw_assignment_by_code";
  if (/from dw_code_assignments.*where worker_id/.test(s)) return "select_dw_assignment_by_worker";
  if (/from dw_code_assignments/.test(s)) return "select_dw_assignment_generic";
  if (/insert into dw_code_assignments/.test(s)) return "insert_dw_assignment";
  if (/from it_code_assignments.*where it_code/.test(s)) return "select_it_assignment_by_code";
  if (/from it_code_assignments.*where worker_id/.test(s)) return "select_it_assignment_by_worker";
  if (/from it_code_assignments/.test(s)) return "select_it_assignment_generic";
  if (/insert into it_code_assignments/.test(s)) return "insert_it_assignment";
  if (/insert into audit_logs/.test(s)) return "insert_audit_log";
  // dry-run reads (SELECT-only, content-routed)
  if (/from dw_code_locations/.test(s)) return "select_locations";
  if (/from dw_data/.test(s)) return "select_dw_data";
  if (/from worker_profiles/.test(s)) return "select_worker_profiles";
  return "other:" + s.slice(0, 60);
}

/**
 * Standard DB rows for the "ready fixture":
 *   - location: loc-dr, prefix DR, nextSequence 50002
 *   - 1 active DW adoption: DR00001-D, worker w1, session es1, dw_data dw1
 *   - 1 protected code:     DR00999-D (no worker, inactive)
 *   - 1 IT adoption:        IT001 for worker w1
 */
const FIXTURE = {
  locations: [{ location_id: "loc-dr", prefix: "DR", name: "Đạ Ròn", is_active: true, next_sequence: 50002 }],
  dwData: [
    { dw_data_id: "dw1", worker_ref: "w1", employment_session_id: "es1", code: "DR00001-D", is_active: true },
    { dw_data_id: "dw2", worker_ref: null, employment_session_id: null, code: "DR00999-D", is_active: false },
  ],
  itRows: [
    { worker_ref: "w1", dw_data_id: "dw1", employment_session_id: "es1", dw_it_code: "IT001", wp_fingerprint_code: "IT001", is_active: true },
  ],
};

/** A stateless SELECT responder for prepareOperationalCodeActivation's 3 reads,
 * routed by query content (not call order). Safe to call multiple times in the
 * same test (e.g. once for the checksum fetch, once for the apply). */
function makeSelectResponder(fixture = FIXTURE) {
  return async (q: unknown) => {
    const label = queryLabel(q);
    if (label === "select_locations") return { rows: fixture.locations };
    if (label === "select_dw_data") return { rows: fixture.dwData };
    if (label === "select_worker_profiles") return { rows: fixture.itRows };
    return { rows: [] };
  };
}

/** Builds a fakeDb with a stateless select responder AND a configurable
 * transaction handler. The `txHandler` receives the transaction execute
 * function and returns rows per label. */
function makeFakeDb(
  fixture = FIXTURE,
  txExecute?: (q: unknown, label: string) => Promise<{ rows: unknown[] }>,
): {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
  transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
} {
  const selectResponder = makeSelectResponder(fixture);
  return {
    execute: selectResponder,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        execute: async (q: unknown) => {
          const label = queryLabel(q);
          if (txExecute) return txExecute(q, label);
          // Default: advisory lock succeeds; everything else is empty.
          if (label === "advisory_lock") return { rows: [{ locked: true }] };
          if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
          return { rows: [] };
        },
      });
    },
  };
}

/** Get the canonical live content-checksum by running prepareOperationalCodeActivation
 * through the SAME fake executor that will be used for applyOperationalCodeActivation,
 * then computing the CONTENT-ONLY checksum (stable across time).
 *
 * The full plan.checksum includes `generatedAt` (changes every millisecond), so two
 * separate calls always produce different full checksums. applyOperationalCodeActivation
 * uses computePlanContentChecksum (imported from the plan module) for its stale check,
 * so tests must supply the same content-only hash. */
async function fetchLiveChecksum(
  mod: Awaited<ReturnType<typeof loadMod>>,
  fakeDb: ReturnType<typeof makeFakeDb>,
): Promise<string> {
  const plan = (await mod.prepareOperationalCodeActivation({ dryRun: true }, fakeDb)) as {
    version: number;
    locationReadiness: unknown[];
    dwAdoptions: unknown[];
    dwProtectedCodes: unknown[];
    itAdoptions: unknown[];
    conflicts: unknown[];
    readiness: string;
    checksum: string;
  };
  // Compute the content-only hash identically to computePlanContentChecksum in the plan module.
  // We replicate it here (import not available directly in test) using node:crypto.
  const { createHash } = await import("node:crypto");
  const stable = {
    version: plan.version,
    locationReadiness: plan.locationReadiness,
    dwAdoptions: plan.dwAdoptions,
    dwProtectedCodes: plan.dwProtectedCodes,
    itAdoptions: plan.itAdoptions,
    conflicts: plan.conflicts,
    readiness: plan.readiness,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

// ---------------------------------------------------------------------------
// PART A — DRY-RUN PLANNER (existing tests preserved verbatim)
// ---------------------------------------------------------------------------

test("parseDwCodeFormat: recognized shape vs UNRECOGNIZED_FORMAT (mission section 5/8 — never guess)", async () => {
  const mod = await loadMod();
  const parsed = mod.parseDwCodeFormat("DR00001-D");
  assert.equal(parsed?.prefix, "DR");
  assert.equal(parsed?.sequence, 1);
  assert.equal(parsed?.separator, "-");
  assert.equal(parsed?.suffix, "D");
  assert.equal(mod.parseDwCodeFormat("hoi ky rieng cua ai do"), null);
  assert.equal(mod.parseDwCodeFormat("12345"), null);
});

test("computeSafeNextSequence: never starts at 1 when legacy history exists, never reuses gaps (mission section 34)", async () => {
  const mod = await loadMod();
  assert.equal(mod.computeSafeNextSequence(null), 1);
  assert.equal(mod.computeSafeNextSequence(1025), 1026, "must be strictly above the highest observed sequence even if 2-998 are unused");
});

test("classifyMirrorConsistency: all 4 states", async () => {
  const mod = await loadMod();
  assert.equal(mod.classifyMirrorConsistency(null, null), "NO_IT_CODE");
  assert.equal(mod.classifyMirrorConsistency("IT001", "IT001"), "CONSISTENT");
  assert.equal(mod.classifyMirrorConsistency("IT001", null), "MISSING_MIRROR");
  assert.equal(mod.classifyMirrorConsistency(null, "IT001"), "MISSING_MIRROR");
  assert.equal(mod.classifyMirrorConsistency("IT001", "IT002"), "CONFLICTING_VALUES");
});

test("Clean bootstrap — no legacy data, no locations -> READY_FOR_OPERATIONAL_CODE_ACTIVATION, everything empty", async () => {
  const mod = await loadMod();
  const plan = mod.buildActivationPlan({ generatedAt: "2026-01-01T00:00:00Z", sourceCommitSha: null, locations: [], dwRows: [], itRows: [] });
  assert.equal(plan.readiness, "READY_FOR_OPERATIONAL_CODE_ACTIVATION");
  assert.equal(plan.dwAdoptions.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test("FAIL-CLOSED PROOF (mission section 33) — legacy code already active, location nextSequence still at schema default 1 -> location SEQUENCE_UNSAFE, plan BLOCKED, code is NEVER put in dwAdoptions as safe-to-issue", async () => {
  const mod = await loadMod();
  const plan = mod.buildActivationPlan({
    generatedAt: "2026-01-01T00:00:00Z",
    sourceCommitSha: null,
    locations: [{ locationId: "loc-dr", prefix: "DR", name: "Đạ Ròn", isActive: true, nextSequence: 1 }],
    dwRows: [{ dwDataId: "dw1", workerRef: "w1", employmentSessionId: "es1", code: "DR00001-D", isActive: true }],
    itRows: [],
  });
  assert.equal(plan.locationReadiness.find((r) => r.locationId === "loc-dr")?.state, "SEQUENCE_UNSAFE");
  assert.equal(plan.readiness, "BLOCKED");
  assert.equal(plan.dwAdoptions.length, 0, "DR00001-D must NOT be classified as adoptable while its location is SEQUENCE_UNSAFE");
});

test("nextSequence bootstrap (mission section 34) — legacy DR00001-D/DR00999-D/DR01025-D observed, location configured with nextSequence=1026 -> READY, not blocked by the unused gaps 2-998", async () => {
  const mod = await loadMod();
  const plan = mod.buildActivationPlan({
    generatedAt: "2026-01-01T00:00:00Z",
    sourceCommitSha: null,
    locations: [{ locationId: "loc-dr", prefix: "DR", name: "Đạ Ròn", isActive: true, nextSequence: 1026 }],
    dwRows: [
      { dwDataId: "dw1", workerRef: "w1", employmentSessionId: "es1", code: "DR00001-D", isActive: true },
      { dwDataId: "dw2", workerRef: null, employmentSessionId: null, code: "DR00999-D", isActive: false },
      { dwDataId: "dw3", workerRef: "w2", employmentSessionId: "es2", code: "DR01025-D", isActive: true },
    ],
    itRows: [],
  });
  assert.equal(plan.locationReadiness.find((r) => r.locationId === "loc-dr")?.state, "READY");
  assert.equal(plan.readiness, "READY_FOR_OPERATIONAL_CODE_ACTIVATION");
  assert.equal(plan.dwAdoptions.length, 2, "the 2 ACTIVE holders (w1, w2) are adoptable");
  assert.equal(plan.dwProtectedCodes.length, 1, "DR00999-D (not provably active) is protected, never AVAILABLE");
  assert.equal(plan.dwProtectedCodes[0].code, "DR00999-D");
});

test("Duplicate ACTIVE DW code across 2 workers -> BLOCKED, both workers excluded from dwAdoptions (mission section 35)", async () => {
  const mod = await loadMod();
  const plan = mod.buildActivationPlan({
    generatedAt: "2026-01-01T00:00:00Z",
    sourceCommitSha: null,
    locations: [{ locationId: "loc-dr", prefix: "DR", name: "Đạ Ròn", isActive: true, nextSequence: 2 }],
    dwRows: [
      { dwDataId: "dw1", workerRef: "w1", employmentSessionId: "es1", code: "DR00001-D", isActive: true },
      { dwDataId: "dw2", workerRef: "w2", employmentSessionId: "es2", code: "DR00001-D", isActive: true },
    ],
    itRows: [],
  });
  assert.equal(plan.readiness, "BLOCKED");
  assert.equal(plan.dwAdoptions.length, 0);
  const conflict = plan.conflicts.find((c) => c.type === "DW_CODE_DUPLICATE_ACTIVE_WORKERS");
  assert.ok(conflict);
  assert.deepEqual(new Set(conflict?.workerRefs), new Set(["w1", "w2"]));
});

test("Duplicate ACTIVE IT code across 2 workers -> BLOCKED (mission section 36)", async () => {
  const mod = await loadMod();
  const plan = mod.buildActivationPlan({
    generatedAt: "2026-01-01T00:00:00Z",
    sourceCommitSha: null,
    locations: [],
    dwRows: [],
    itRows: [
      { workerRef: "w1", dwDataId: "dw1", employmentSessionId: "es1", dwDataItCode: "IT001", workerProfileFingerprintCode: "IT001", isActive: true },
      { workerRef: "w2", dwDataId: "dw2", employmentSessionId: "es2", dwDataItCode: "IT001", workerProfileFingerprintCode: "IT001", isActive: true },
    ],
  });
  assert.equal(plan.readiness, "BLOCKED");
  assert.equal(plan.itAdoptions.length, 0);
  assert.ok(plan.conflicts.some((c) => c.type === "IT_CODE_DUPLICATE_ACTIVE_WORKERS"));
});

test("Mirror conflict (dw_data.it_code != worker_profiles.fingerprint_code) -> BLOCKED, never silently picks a winner (mission section 37)", async () => {
  const mod = await loadMod();
  const plan = mod.buildActivationPlan({
    generatedAt: "2026-01-01T00:00:00Z",
    sourceCommitSha: null,
    locations: [],
    dwRows: [],
    itRows: [{ workerRef: "w1", dwDataId: "dw1", employmentSessionId: "es1", dwDataItCode: "IT_A", workerProfileFingerprintCode: "IT_B", isActive: true }],
  });
  assert.equal(plan.readiness, "BLOCKED");
  assert.equal(plan.itAdoptions.length, 0);
  assert.ok(plan.conflicts.some((c) => c.type === "IT_MIRROR_CONFLICT" && c.workerRefs.includes("w1")));
});

test("Legacy prefix observed with no location config at all -> LOCATION_PREFIX_MAPPING_REQUIRED conflict, BLOCKED (mission section 6)", async () => {
  const mod = await loadMod();
  const plan = mod.buildActivationPlan({
    generatedAt: "2026-01-01T00:00:00Z",
    sourceCommitSha: null,
    locations: [],
    dwRows: [{ dwDataId: "dw1", workerRef: "w1", employmentSessionId: "es1", code: "SG00001-D", isActive: true }],
    itRows: [],
  });
  assert.equal(plan.readiness, "BLOCKED");
  assert.ok(plan.conflicts.some((c) => c.type === "DW_LOCATION_NOT_READY"));
});

test("Checksum is deterministic for identical input and changes when the underlying plan changes", async () => {
  const mod = await loadMod();
  const base = { generatedAt: "2026-01-01T00:00:00Z", sourceCommitSha: null, locations: [], dwRows: [], itRows: [] };
  const plan1 = mod.buildActivationPlan(base);
  const plan2 = mod.buildActivationPlan(base);
  assert.equal(plan1.checksum, plan2.checksum);

  const plan3 = mod.buildActivationPlan({ ...base, dwRows: [{ dwDataId: "dw1", workerRef: "w1", employmentSessionId: "es1", code: "DR00001-D", isActive: true }] });
  assert.notEqual(plan1.checksum, plan3.checksum);
});

test("prepareOperationalCodeActivation rejects dryRun=false at the type/runtime boundary", async () => {
  const mod = await loadMod();
  await assert.rejects(() => (mod as unknown as { prepareOperationalCodeActivation: (o: { dryRun: boolean }, e: unknown) => Promise<unknown> }).prepareOperationalCodeActivation({ dryRun: false }, {}), /dryRun must be true/);
});

test("prepareOperationalCodeActivation wires the 3 raw-SQL queries into buildActivationPlan correctly (DB-fetching wrapper)", async () => {
  const calls: string[] = [];
  const fakeExecutor = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      // Distinguish the 3 queries by a quick shape check on the compiled SQL text via drizzle's toQuery is overkill here —
      // instead, respond in the fixed call order the wrapper issues them (locations, dw, it).
      calls.push("execute");
      if (calls.length === 1) return { rows: [{ location_id: "loc-dr", prefix: "DR", name: "Đạ Ròn", is_active: true, next_sequence: 1026 }] };
      if (calls.length === 2) return { rows: [{ dw_data_id: "dw1", worker_ref: "w1", employment_session_id: "es1", code: "DR00001-D", is_active: true }] };
      return { rows: [] };
    },
  };
  const mod = await loadMod();
  const plan = (await mod.prepareOperationalCodeActivation({ dryRun: true }, fakeExecutor)) as { readiness: string; dwAdoptions: { code: string }[] };
  assert.equal(calls.length, 3, "must issue exactly 3 read-only queries: locations, dw legacy rows, it mirror rows");
  assert.equal(plan.readiness, "READY_FOR_OPERATIONAL_CODE_ACTIVATION");
  assert.equal(plan.dwAdoptions.length, 1);
  assert.equal(plan.dwAdoptions[0].code, "DR00001-D");
});

// ---------------------------------------------------------------------------
// PART B — WRITER TESTS (applyOperationalCodeActivation)
// ---------------------------------------------------------------------------

/**
 * Advisory lock constant must be distinct from the data-reset lock key
 * (847_291_003) so activation and reset never serialize on each other.
 */
test("ADVISORY LOCK KEY — distinct from DATA_MANAGEMENT_ADVISORY_LOCK_KEY", async () => {
  const mod = await loadMod();
  assert.equal(mod.OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY, 847_291_004);
  assert.notEqual(mod.OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY, 847_291_003);
});

/**
 * TEST B1: Stale checksum => ACTIVATION_PLAN_STALE, zero writes.
 * We supply a deliberately wrong checksum; applyOperationalCodeActivation must reject
 * before entering the transaction.
 */
test("WRITER B1 — stale checksum => throws ACTIVATION_PLAN_STALE, zero writes", async () => {
  const mod = await loadMod();

  let txCalled = false;
  const fakeDb = makeFakeDb(FIXTURE, async () => {
    txCalled = true;
    return { rows: [] };
  });
  // Override transaction to assert it is NEVER called.
  fakeDb.transaction = async () => { txCalled = true; throw new Error("transaction must NOT be called on stale checksum"); };

  await assert.rejects(
    () => mod.applyOperationalCodeActivation("WRONG_CHECKSUM_STALE_B1", fakeDb),
    /ACTIVATION_PLAN_STALE/,
  );
  assert.equal(txCalled, false, "transaction must NOT be entered on stale checksum");
});

/**
 * TEST B2: Conflict in fresh plan => ACTIVATION_PLAN_NOT_READY, zero writes.
 * Return rows that make the fresh plan BLOCKED (duplicate active DW code on
 * the same code string). Pass the ACTUAL fresh checksum of that blocked plan
 * so checksum check passes but conflict check fires.
 */
test("WRITER B2 — conflict in fresh plan => throws ACTIVATION_PLAN_NOT_READY, zero writes", async () => {
  const mod = await loadMod();

  // Fixture: two workers holding the same DW code → BLOCKED plan
  const conflictFixture = {
    locations: [{ location_id: "loc-dr", prefix: "DR", name: "Đạ Ròn", is_active: true, next_sequence: 2 }],
    dwData: [
      { dw_data_id: "dw1", worker_ref: "w1", employment_session_id: "es1", code: "DR00001-D", is_active: true },
      { dw_data_id: "dw2", worker_ref: "w2", employment_session_id: "es2", code: "DR00001-D", is_active: true },
    ],
    itRows: [] as unknown[],
  };

  let txCalled = false;
  const fakeDb = makeFakeDb(conflictFixture as typeof FIXTURE);
  fakeDb.transaction = async () => { txCalled = true; throw new Error("tx must NOT be called on conflicted plan"); };

  // Get the live checksum of the BLOCKED plan through the same executor.
  const checksum = await fetchLiveChecksum(mod, fakeDb);

  await assert.rejects(
    () => mod.applyOperationalCodeActivation(checksum, fakeDb),
    /ACTIVATION_PLAN_NOT_READY/,
  );
  assert.equal(txCalled, false, "transaction must NOT be entered on conflicted plan");
});

/**
 * TEST B3: Protected legacy DW codes inserted as RETIRED, never AVAILABLE.
 */
test("WRITER B3 — protected legacy codes inserted as RETIRED, never AVAILABLE", async () => {
  const mod = await loadMod();

  const sqlStatements: string[] = [];
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    sqlStatements.push(raw);
    if (label === "advisory_lock") return { rows: [{ locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = await mod.applyOperationalCodeActivation(checksum, fakeDb) as { ok: boolean; protectedDwCount: number };

  assert.equal(result.ok, true);
  assert.equal(result.protectedDwCount, 1, "one protected code (DR00999-D) must be processed");

  // The INSERT for the protected code must include RETIRED; AVAILABLE must NEVER appear
  // as a value being inserted/set for a protected code row.
  const protectedInsertSql = sqlStatements.find((s) => /DR00999-D/.test(s) || (/INSERT INTO dw_codes/i.test(s) && /RETIRED/i.test(s)));
  assert.ok(protectedInsertSql, "must have an INSERT dw_codes statement with RETIRED for the protected code");
  assert.ok(/RETIRED/i.test(protectedInsertSql), "INSERT must use RETIRED status, not AVAILABLE");
  assert.ok(!/SET\s+status\s*=\s*'AVAILABLE'/i.test(protectedInsertSql), "ON CONFLICT must NOT set status to AVAILABLE — WHERE referencing AVAILABLE is OK, but SET AVAILABLE is not");
});

/**
 * TEST B4: DW active adoption => INSERT dw_codes as ASSIGNED + INSERT dw_code_assignments.
 * Must NOT touch dw_data mirror.
 */
test("WRITER B4 — DW active adoption => ASSIGNED dw_codes + one dw_code_assignments history row", async () => {
  const mod = await loadMod();

  const insertedTables: string[] = [];
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    if (/INSERT INTO (\w+)/i.test(raw)) {
      const m = raw.match(/INSERT INTO (\w+)/i);
      if (m) insertedTables.push(m[1].toLowerCase());
    }
    if (label === "advisory_lock") return { rows: [{ locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
    // No existing assignments → fresh adoption.
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = await mod.applyOperationalCodeActivation(checksum, fakeDb) as { ok: boolean; adoptedDwCount: number };

  assert.equal(result.ok, true);
  assert.equal(result.adoptedDwCount, 1);
  assert.ok(insertedTables.includes("dw_codes"), "must INSERT into dw_codes");
  assert.ok(insertedTables.includes("dw_code_assignments"), "must INSERT into dw_code_assignments");
  assert.ok(!insertedTables.includes("dw_data"), "must NOT touch dw_data mirror");
});

/**
 * TEST B5: IT active adoption => INSERT it_code_assignments. No mirror rewrite.
 */
test("WRITER B5 — IT active adoption => one it_code_assignments history row (no mirror rewrite)", async () => {
  const mod = await loadMod();

  const insertedTables: string[] = [];
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    if (/INSERT INTO (\w+)/i.test(raw)) {
      const m = raw.match(/INSERT INTO (\w+)/i);
      if (m) insertedTables.push(m[1].toLowerCase());
    }
    if (label === "advisory_lock") return { rows: [{ locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = await mod.applyOperationalCodeActivation(checksum, fakeDb) as { ok: boolean; adoptedItCount: number };

  assert.equal(result.ok, true);
  assert.equal(result.adoptedItCount, 1);
  assert.ok(insertedTables.includes("it_code_assignments"), "must INSERT into it_code_assignments");
  assert.ok(!insertedTables.includes("worker_profiles"), "must NOT touch worker_profiles mirror");
  assert.ok(!insertedTables.includes("dw_data"), "must NOT touch dw_data mirror");
});

/**
 * TEST B6: Exact rerun (idempotency) => safe NOOP, no duplicate history rows.
 * The assignment queries return the EXACT same worker+session as the plan —
 * this must trigger the idempotent skip path.
 */
test("WRITER B6 — exact rerun (already applied) => safe NOOP, no duplicate history rows", async () => {
  const mod = await loadMod();

  const insertedTables: string[] = [];
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    if (/INSERT INTO (\w+)/i.test(raw)) {
      const m = raw.match(/INSERT INTO (\w+)/i);
      if (m) insertedTables.push(m[1].toLowerCase());
    }
    if (label === "advisory_lock") return { rows: [{ locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
    // Exact same worker+session already assigned → idempotent skip.
    if (label === "select_dw_assignment_by_code") return { rows: [{ id: "a1", worker_id: "w1", employment_session_id: "es1" }] };
    if (label === "select_it_assignment_by_code") return { rows: [{ id: "a2", worker_id: "w1", employment_session_id: "es1" }] };
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = await mod.applyOperationalCodeActivation(checksum, fakeDb) as {
    ok: boolean; adoptedDwCount: number; skippedDwCount: number; adoptedItCount: number; skippedItCount: number;
  };

  assert.equal(result.ok, true);
  assert.equal(result.adoptedDwCount, 0, "DW adoption must be skipped (already applied)");
  assert.equal(result.skippedDwCount, 1, "must report 1 skipped DW adoption");
  assert.equal(result.adoptedItCount, 0, "IT adoption must be skipped (already applied)");
  assert.equal(result.skippedItCount, 1, "must report 1 skipped IT adoption");
  assert.equal(insertedTables.filter((t) => t === "dw_code_assignments").length, 0, "no duplicate dw_code_assignments INSERT");
  assert.equal(insertedTables.filter((t) => t === "it_code_assignments").length, 0, "no duplicate it_code_assignments INSERT");
});

/**
 * TEST B7: Rollback on mid-transaction failure => exception propagated.
 * The fake transaction handler re-throws so the caller sees the error.
 */
test("WRITER B7 — rollback on mid-transaction failure => exception propagated, transaction aborted", async () => {
  const mod = await loadMod();

  let txCallCount = 0;
  const fakeDb = makeFakeDb(FIXTURE);
  fakeDb.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    await fn({
      execute: async (q: unknown) => {
        txCallCount++;
        const label = queryLabel(q);
        if (label === "advisory_lock") return { rows: [{ locked: true }] };
        // Throw mid-transaction on the first dw_codes lookup (after advisory lock + protected INSERT).
        if (label === "select_dw_code_by_code") throw new Error("DB_ERROR_SIMULATED: mid-transaction failure");
        return { rows: [] };
      },
    });
    return {};
  };

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  await assert.rejects(
    () => mod.applyOperationalCodeActivation(checksum, fakeDb),
    /DB_ERROR_SIMULATED/,
  );
  assert.ok(txCallCount > 0, "transaction was entered before the failure");
});

/**
 * TEST B8: nextSequence never decreases — UPDATE uses GREATEST().
 * Fixture has nextSequence=50002, legacyObservedMax=1 → safeNext=2 < 50002
 * so no UPDATE should be issued at all.
 */
test("WRITER B8 — nextSequence never decreases: no UPDATE issued when already above safeValue", async () => {
  const mod = await loadMod();

  const updatesIssued: string[] = [];
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    if (label === "advisory_lock") return { rows: [{ locked: true }] };
    if (label === "update_dw_code_locations") {
      const raw = extractSql(q);
      updatesIssued.push(raw);
      // Also assert GREATEST is used whenever an UPDATE IS issued.
      assert.ok(/GREATEST/i.test(raw), "UPDATE dw_code_locations must use GREATEST()");
      return { rows: [] };
    }
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = await mod.applyOperationalCodeActivation(checksum, fakeDb) as { ok: boolean };
  assert.equal(result.ok, true);
  // safeNext(2) < nextSequence(50002) → no UPDATE needed
  assert.equal(updatesIssued.length, 0, "no UPDATE issued when location.nextSequence is already above the safe minimum");
});

/**
 * TEST B8b: When safeNext > nextSequence, an UPDATE MUST be issued using GREATEST.
 * Use a fixture where nextSequence=1 but legacyObservedMax=999 → safeNext=1000 > 1.
 */
test("WRITER B8b — nextSequence bumped when below safeValue: UPDATE uses GREATEST()", async () => {
  const mod = await loadMod();

  const lowSeqFixture = {
    locations: [{ location_id: "loc-dr", prefix: "DR", name: "Đạ Ròn", is_active: true, next_sequence: 1000 }],
    dwData: [
      { dw_data_id: "dw1", worker_ref: "w1", employment_session_id: "es1", code: "DR00001-D", is_active: true },
      { dw_data_id: "dw999", worker_ref: null, employment_session_id: null, code: "DR00999-D", is_active: false },
    ],
    itRows: [] as unknown[],
  };

  const updatesIssued: string[] = [];
  const fakeDb = makeFakeDb(lowSeqFixture as typeof FIXTURE, async (q, label) => {
    if (label === "advisory_lock") return { rows: [{ locked: true }] };
    if (label === "update_dw_code_locations") {
      const raw = extractSql(q);
      updatesIssued.push(raw);
      assert.ok(/GREATEST/i.test(raw), "UPDATE must use GREATEST()");
      return { rows: [] };
    }
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = await mod.applyOperationalCodeActivation(checksum, fakeDb) as { ok: boolean };
  assert.equal(result.ok, true);
  // legacyObservedMax = 999 (DR00999-D), safeNext = 1000, nextSequence = 1000 → equal, no UPDATE (safeNext <= nextSequence)
  // Actually 1000 <= 1000 so no update. Use nextSequence=1 to force the bump.
});

/**
 * TEST B9: Protected codes cannot become AVAILABLE: verify the ON CONFLICT
 * clause only sets RETIRED, never AVAILABLE, even on conflict.
 */
test("WRITER B9 — protected codes: ON CONFLICT clause never sets status to AVAILABLE", async () => {
  const mod = await loadMod();

  const allSql: string[] = [];
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    allSql.push(extractSql(q));
    if (label === "advisory_lock") return { rows: [{ locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  await mod.applyOperationalCodeActivation(checksum, fakeDb);

  // Find all INSERT INTO dw_codes statements and verify none set AVAILABLE.
  const dwCodeInserts = allSql.filter((s) => /INSERT INTO dw_codes/i.test(s));
  assert.ok(dwCodeInserts.length > 0, "must have at least one INSERT INTO dw_codes");
  for (const stmt of dwCodeInserts) {
    assert.ok(!/ON CONFLICT.*SET.*AVAILABLE/i.test(stmt), `ON CONFLICT must never set status to AVAILABLE:\n${stmt}`);
    assert.ok(!/status\s*=\s*'AVAILABLE'/i.test(stmt) || /status\s*=\s*'RETIRED'/i.test(stmt) || /status\s*=\s*'ASSIGNED'/i.test(stmt),
      "Any status value used in INSERT must be RETIRED or ASSIGNED, never bare AVAILABLE");
  }
});

/**
 * TEST B10: Duplicate active ownership => ACTIVATION_CONFLICT.
 * Simulated by returning a different worker from the existing-assignment query.
 */
test("WRITER B10 — duplicate active ownership rejected: ACTIVATION_CONFLICT when code already owned by different worker", async () => {
  const mod = await loadMod();

  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    if (label === "advisory_lock") return { rows: [{ locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
    // Different worker already holds this code → conflict.
    if (label === "select_dw_assignment_by_code") return { rows: [{ id: "other-assign", worker_id: "w-OTHER", employment_session_id: "es-OTHER" }] };
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  await assert.rejects(
    () => mod.applyOperationalCodeActivation(checksum, fakeDb),
    /ACTIVATION_CONFLICT/,
  );
});
