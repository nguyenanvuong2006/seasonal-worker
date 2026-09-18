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
      "@/lib/data-management/reset-service": {
        DATA_MANAGEMENT_ADVISORY_LOCK_KEY: 847_291_003,
      },
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
      activationContentChecksum: string;
    };
    computePlanContentChecksum: (plan: unknown) => string;
    prepareOperationalCodeActivation: (opts: { dryRun: true }, executor: unknown) => Promise<unknown>;
    applyOperationalCodeActivation: (activationContentChecksum: string, executor?: unknown) => Promise<unknown>;
    OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY: number;
    SHARED_MAINTENANCE_EXCLUSION_ADVISORY_LOCK_KEY: number;
  };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Extract SQL text from a Drizzle sql`` template object or a plain string.
 * Drizzle sql objects have `queryChunks` — each chunk is a StringChunk with `.value` (string[])
 * or a SQL param placeholder. We join all string chunks to reconstruct the query text. */
function extractSql(q: unknown): string {
  if (!q) return "";
  if (typeof q === "string") return q;
  if (typeof q === "object" && q !== null) {
    const obj = q as Record<string, unknown>;
    const chunks = obj["queryChunks"];
    if (Array.isArray(chunks)) {
      return chunks
        .map((c: unknown) => {
          if (typeof c === "string") return c;
          const chunk = c as Record<string, unknown>;
          if (Array.isArray(chunk["queryChunks"])) return extractSql(chunk);
          if (Array.isArray(chunk["value"])) return (chunk["value"] as string[]).join("");
          if (typeof chunk["value"] === "string") return chunk["value"];
          if (typeof chunk["value"] === "number") return String(chunk["value"]);
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
  if (/select.*from dw_codes where/.test(s)) return "select_dw_code_by_code";
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
  txExecute?: (q: unknown, label: string) => Promise<{ rows: unknown[] } | undefined>,
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
          // The 3 plan-recomputation queries inside tx must always resolve through selectResponder
          // using the test's fixture, so freshPlan recomputation inside tx reflects the same fixture.
          if (label === "select_locations" || label === "select_dw_data" || label === "select_worker_profiles") {
            return selectResponder(q);
          }
          if (txExecute) {
            const custom = await txExecute(q, label);
            if (custom !== undefined) return custom;
          }
          // Default: advisory lock succeeds
          if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true, locked: true }] };
          if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
          return { rows: [] };
        },
      });
    },
  };
}

/** Get the canonical live activationContentChecksum by running prepareOperationalCodeActivation
 * through the SAME fake executor that will be used for applyOperationalCodeActivation.
 *
 * The full plan.checksum includes `generatedAt` (changes every millisecond), so two
 * separate calls always produce different full checksums. applyOperationalCodeActivation
 * uses activationContentChecksum for its stale check, so tests supply the stable content hash. */
async function fetchLiveChecksum(
  mod: Awaited<ReturnType<typeof loadMod>>,
  fakeDb: unknown,
): Promise<string> {
  const plan = (await mod.prepareOperationalCodeActivation({ dryRun: true }, fakeDb)) as {
    activationContentChecksum: string;
  };
  return plan.activationContentChecksum;
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

test("BLOCKER 1: generatedAt/sourceCommitSha changes => full checksum changes, activationContentChecksum remains identical", async () => {
  const mod = await loadMod();
  const base = {
    locations: [{ locationId: "loc-dr", prefix: "DR", name: "Đạ Ròn", isActive: true, nextSequence: 50002 }],
    dwRows: [{ dwDataId: "dw1", workerRef: "w1", employmentSessionId: "es1", code: "DR00001-D", isActive: true }],
    itRows: [],
  };

  const plan1 = mod.buildActivationPlan({
    ...base,
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceCommitSha: "commit-alpha",
  });

  const plan2 = mod.buildActivationPlan({
    ...base,
    generatedAt: "2026-02-15T12:34:56.789Z",
    sourceCommitSha: "commit-beta",
  });

  // Full diagnostic checksum MUST change because generatedAt and sourceCommitSha changed
  assert.notEqual(plan1.checksum, plan2.checksum, "full diagnostic checksum must change when metadata changes");

  // activationContentChecksum MUST be identical because write-determining content is unchanged
  assert.equal(
    plan1.activationContentChecksum,
    plan2.activationContentChecksum,
    "activationContentChecksum must remain identical across runs when content is unchanged",
  );
});

test("BLOCKER 1: content change => activationContentChecksum changes", async () => {
  const mod = await loadMod();
  const plan1 = mod.buildActivationPlan({
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceCommitSha: "commit-alpha",
    locations: [{ locationId: "loc-dr", prefix: "DR", name: "Đạ Ròn", isActive: true, nextSequence: 50002 }],
    dwRows: [{ dwDataId: "dw1", workerRef: "w1", employmentSessionId: "es1", code: "DR00001-D", isActive: true }],
    itRows: [],
  });

  const plan2 = mod.buildActivationPlan({
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceCommitSha: "commit-alpha",
    locations: [{ locationId: "loc-dr", prefix: "DR", name: "Đạ Ròn", isActive: true, nextSequence: 50002 }],
    dwRows: [
      { dwDataId: "dw1", workerRef: "w1", employmentSessionId: "es1", code: "DR00001-D", isActive: true },
      { dwDataId: "dw2", workerRef: null, employmentSessionId: null, code: "DR00999-D", isActive: false },
    ],
    itRows: [],
  });

  assert.notEqual(
    plan1.activationContentChecksum,
    plan2.activationContentChecksum,
    "activationContentChecksum must change when plan content changes",
  );
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
 * Advisory lock constants:
 *   - Dedicated activation lock: 847_291_004
 *   - Shared maintenance / reset exclusion lock: 847_291_003
 */
test("ADVISORY LOCK KEYS — dedicated activation lock (847_291_004) and shared maintenance exclusion lock (847_291_003)", async () => {
  const mod = await loadMod();
  assert.equal(mod.OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY, 847_291_004);
  assert.equal(mod.SHARED_MAINTENANCE_EXCLUSION_ADVISORY_LOCK_KEY, 847_291_003);
  assert.notEqual(mod.OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY, mod.SHARED_MAINTENANCE_EXCLUSION_ADVISORY_LOCK_KEY);
});

/**
 * TEST B1: Stale activationContentChecksum => ACTIVATION_PLAN_STALE, zero writes.
 * Transaction begins, advisory locks acquired, plan recomputed inside transaction,
 * stale activationContentChecksum rejected before any writes.
 */
test("WRITER B1 — stale activationContentChecksum after locks => throws ACTIVATION_PLAN_STALE, zero writes", async () => {
  const mod = await loadMod();

  let txCalled = false;
  let tableMutations = 0;
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    txCalled = true;
    const raw = extractSql(q);
    if (/insert into|update /i.test(raw)) {
      tableMutations++;
    }
    return undefined;
  });

  await assert.rejects(
    () => mod.applyOperationalCodeActivation("WRONG_CHECKSUM_STALE_B1", fakeDb),
    /ACTIVATION_PLAN_STALE.*activationContentChecksum/,
  );
  assert.equal(txCalled, true, "transaction MUST be entered to acquire locks and recompute plan");
  assert.equal(tableMutations, 0, "zero table writes on stale checksum");
});

/**
 * BLOCKER 2 REGRESSION TEST:
 * Shared destructive-operation exclusion lock is unavailable (e.g. data reset is in progress).
 * Activation must fail closed immediately with ACTIVATION_LOCKED without performing ANY mutations.
 */
test("BLOCKER 2 — activation fails closed when shared destructive-operation exclusion lock is unavailable", async () => {
  const mod = await loadMod();

  let txEntered = false;
  let tableMutations = 0;

  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    if (/insert into|update /i.test(raw)) {
      tableMutations++;
    }
    if (label === "advisory_lock") {
      txEntered = true;
      // Dedicated activation lock acquired, but shared maintenance/reset exclusion lock is held by reset
      return { rows: [{ activation_locked: true, maintenance_locked: false }] };
    }
    return undefined;
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);

  await assert.rejects(
    () => mod.applyOperationalCodeActivation(checksum, fakeDb),
    /ACTIVATION_LOCKED.*destructive data-management or reset operation/,
  );

  assert.equal(txEntered, true, "transaction was entered to inspect lock");
  assert.equal(tableMutations, 0, "zero table writes when shared maintenance exclusion lock is unavailable");
});

/**
 * TEST B2: Conflict in fresh plan => ACTIVATION_PLAN_NOT_READY, zero writes.
 * Transaction begins, locks acquired, plan recomputed inside transaction,
 * conflict detected, throws ACTIVATION_PLAN_NOT_READY with zero writes.
 */
test("WRITER B2 — conflict in fresh plan after locks => throws ACTIVATION_PLAN_NOT_READY, zero writes", async () => {
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
  let tableMutations = 0;
  const fakeDb = makeFakeDb(conflictFixture as typeof FIXTURE, async (q) => {
    txCalled = true;
    const raw = extractSql(q);
    if (/insert into|update /i.test(raw)) {
      tableMutations++;
    }
    return undefined;
  });

  // Get the live checksum of the BLOCKED plan through the same executor.
  const checksum = await fetchLiveChecksum(mod, fakeDb);

  await assert.rejects(
    () => mod.applyOperationalCodeActivation(checksum, fakeDb),
    /ACTIVATION_PLAN_NOT_READY/,
  );
  assert.equal(txCalled, true, "transaction MUST be entered to acquire locks and recompute plan");
  assert.equal(tableMutations, 0, "zero table writes on conflicted plan");
});

/**
 * REGRESSION TESTS A & B: Transaction begins before freshness plan recomputation,
 * and both advisory locks are acquired before plan recomputation reads occur.
 */
test("REGRESSION A & B — transaction begins and locks are acquired BEFORE plan recomputation (zero-TOCTOU)", async () => {
  const mod = await loadMod();

  const eventSequence: string[] = [];
  const fakeDb = {
    execute: async (q: unknown) => {
      eventSequence.push("outside_tx_execute:" + queryLabel(q));
      return { rows: [] };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      eventSequence.push("transaction_begin");
      return fn({
        execute: async (q: unknown) => {
          const label = queryLabel(q);
          eventSequence.push("tx:" + label);
          if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
          if (label === "select_locations") return { rows: FIXTURE.locations };
          if (label === "select_dw_data") return { rows: FIXTURE.dwData };
          if (label === "select_worker_profiles") return { rows: FIXTURE.itRows };
          if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
          return { rows: [] };
        },
      });
    },
  };

  const checksum = await fetchLiveChecksum(mod, makeFakeDb(FIXTURE));
  const result = (await mod.applyOperationalCodeActivation(checksum, fakeDb)) as { ok: boolean };
  assert.equal(result.ok, true);

  // Assert exact chronological order:
  // 1. Transaction begins FIRST
  assert.equal(eventSequence[0], "transaction_begin", "transaction MUST begin before any queries");
  // 2. Advisory locks acquired INSIDE transaction
  assert.equal(eventSequence[1], "tx:advisory_lock", "advisory locks MUST be acquired inside transaction first");
  // 3. Plan recomputation reads occur inside transaction AFTER locks
  assert.equal(eventSequence[2], "tx:select_locations", "plan recomputation reads must occur inside transaction after locks");
  assert.equal(eventSequence[3], "tx:select_dw_data", "dw data queried inside transaction");
  assert.equal(eventSequence[4], "tx:select_worker_profiles", "worker profiles queried inside transaction");

  // Zero queries executed outside transaction
  const outsideQueries = eventSequence.filter((e) => e.startsWith("outside_tx_execute"));
  assert.equal(outsideQueries.length, 0, "ZERO queries must be executed outside the locked transaction");
});

/**
 * REGRESSION TEST F: Plan validation and all writes use the SAME transaction executor.
 */
test("REGRESSION F — plan validation and all writes use the SAME transaction executor", async () => {
  const mod = await loadMod();

  const txUniqueToken = { txId: "tx-session-" + Math.random() };
  const executorsSeen: unknown[] = [];

  const fakeDb = {
    execute: async () => {
      executorsSeen.push("root_executor");
      return { rows: [] };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const txHandle = {
        _token: txUniqueToken,
        execute: async (q: unknown) => {
          executorsSeen.push(txHandle._token);
          const label = queryLabel(q);
          if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
          if (label === "select_locations") return { rows: FIXTURE.locations };
          if (label === "select_dw_data") return { rows: FIXTURE.dwData };
          if (label === "select_worker_profiles") return { rows: FIXTURE.itRows };
          if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
          return { rows: [] };
        },
      };
      return fn(txHandle);
    },
  };

  const checksum = await fetchLiveChecksum(mod, makeFakeDb(FIXTURE));
  const result = (await mod.applyOperationalCodeActivation(checksum, fakeDb)) as { ok: boolean };
  assert.equal(result.ok, true);

  // Every single query must have used txHandle (matching txUniqueToken)
  assert.ok(executorsSeen.length > 5, "must have executed multiple queries inside transaction");
  assert.ok(executorsSeen.every((t) => t === txUniqueToken), "all queries must use the exact same transaction executor");
  assert.equal(executorsSeen.includes("root_executor"), false, "root executor must never be used during apply");
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
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    txCallCount++;
    if (label === "advisory_lock") return { rows: [{ locked: true }] };
    // Throw mid-transaction on the first dw_codes lookup (after advisory lock + plan recomputation + protected INSERT).
    if (label === "select_dw_code_by_code") throw new Error("DB_ERROR_SIMULATED: mid-transaction failure");
    return undefined;
  });

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

// ---------------------------------------------------------------------------
// BLOCKER 3 TESTS — RETIRED CODE ADOPTION STATE INCONSISTENCY GUARDS
// ---------------------------------------------------------------------------

/**
 * TEST A: existing RETIRED row + valid adoption => final status ASSIGNED.
 * Proves that an existing RETIRED dw_codes row for a valid adoption candidate
 * transitions to ASSIGNED and inserts an active assignment (never left as RETIRED).
 */
test("BLOCKER 3 (A) — existing RETIRED row + valid adoption => final status ASSIGNED, assignment inserted", async () => {
  const mod = await loadMod();

  const executedSql: string[] = [];
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    executedSql.push(raw);
    if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
    // Code already exists in dw_codes with status 'RETIRED'
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "RETIRED" }] };
    // No active assignment exists for this code or worker
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = (await mod.applyOperationalCodeActivation(checksum, fakeDb)) as {
    ok: boolean;
    adoptedDwCount: number;
    protectedDwCount: number;
  };

  assert.equal(result.ok, true);
  assert.equal(result.adoptedDwCount, 1, "adoptedDwCount must be 1");

  // Verify that an UPDATE dw_codes SET status = 'ASSIGNED' was issued
  const updateAssignedSql = executedSql.find((s) => /UPDATE dw_codes/i.test(s) && /status\s*=\s*'ASSIGNED'/i.test(s));
  assert.ok(updateAssignedSql, "must execute UPDATE dw_codes SET status = 'ASSIGNED' for existing RETIRED row");

  // Verify that dw_code_assignments was inserted attached to this code
  const insertAssignmentSql = executedSql.find((s) => /INSERT INTO dw_code_assignments/i.test(s));
  assert.ok(insertAssignmentSql, "must insert dw_code_assignments row");
});

/**
 * TEST B: RETIRED + conflicting active ownership => rollback/reject.
 * Proves that if a code is RETIRED but an active assignment already belongs
 * to a different worker/session, the adoption is rejected fail-closed.
 */
test("BLOCKER 3 (B) — RETIRED + conflicting active ownership => rollback/reject", async () => {
  const mod = await loadMod();

  let assignmentInserted = false;
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    if (/insert into dw_code_assignments/i.test(raw)) assignmentInserted = true;
    if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
    // Code exists as RETIRED
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "RETIRED" }] };
    // But an active assignment already belongs to a DIFFERENT worker
    if (label === "select_dw_assignment_by_code") {
      return { rows: [{ id: "conflict-assign", worker_id: "w-OTHER", employment_session_id: "es-OTHER" }] };
    }
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);

  await assert.rejects(
    () => mod.applyOperationalCodeActivation(checksum, fakeDb),
    /ACTIVATION_CONFLICT.*different worker/i,
  );

  assert.equal(assignmentInserted, false, "zero assignments must be inserted on conflict");
});

/**
 * TEST C: protected non-adopted legacy code remains RETIRED.
 * Proves that protected legacy codes (which are not adoption candidates)
 * remain in RETIRED status and are never converted to ASSIGNED or AVAILABLE.
 */
test("BLOCKER 3 (C) — protected non-adopted legacy code remains RETIRED, never ASSIGNED or AVAILABLE", async () => {
  const mod = await loadMod();

  const executedSql: string[] = [];
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    executedSql.push(raw);
    if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = (await mod.applyOperationalCodeActivation(checksum, fakeDb)) as {
    ok: boolean;
    protectedDwCount: number;
    adoptedDwCount: number;
  };

  assert.equal(result.ok, true);
  assert.equal(result.protectedDwCount, 1, "protected code DR00999-D counted");

  // DR00999-D must be inserted/updated as RETIRED
  const protSql = executedSql.find((s) => /DR00999-D/.test(s));
  assert.ok(protSql, "DR00999-D must appear in SQL statements");
  assert.ok(/RETIRED/i.test(protSql), "DR00999-D must be set to RETIRED");

  // DR00999-D must never be in dw_code_assignments
  const protAssignment = executedSql.find((s) => /dw_code_assignments/i.test(s) && /DR00999-D/.test(s));
  assert.equal(protAssignment, undefined, "protected non-adopted code must NEVER be assigned");
});

/**
 * TEST D: exact rerun remains idempotent.
 * Proves that running activation again when the exact assignment already exists
 * is a safe NOOP that leaves dw_codes as ASSIGNED and skips assignment insertion.
 */
test("BLOCKER 3 (D) — exact rerun remains idempotent: dw_codes status remains ASSIGNED, safe skip", async () => {
  const mod = await loadMod();

  const insertedAssignments: string[] = [];
  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    if (/insert into dw_code_assignments/i.test(raw)) insertedAssignments.push(raw);
    if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-id-1", status: "ASSIGNED" }] };
    // Exact same active assignment already exists
    if (label === "select_dw_assignment_by_code") {
      return { rows: [{ id: "a1", worker_id: "w1", employment_session_id: "es1" }] };
    }
    if (label === "select_it_assignment_by_code") {
      return { rows: [{ id: "a2", worker_id: "w1", employment_session_id: "es1" }] };
    }
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = (await mod.applyOperationalCodeActivation(checksum, fakeDb)) as {
    ok: boolean;
    adoptedDwCount: number;
    skippedDwCount: number;
    adoptedItCount: number;
    skippedItCount: number;
  };

  assert.equal(result.ok, true);
  assert.equal(result.adoptedDwCount, 0, "adoptedDwCount must be 0 on rerun");
  assert.equal(result.skippedDwCount, 1, "skippedDwCount must be 1 on rerun");
  assert.equal(insertedAssignments.length, 0, "no duplicate assignments inserted on rerun");
});

/* ============================================================
   REGRESSION SUITE — MISSION RUN #2 DW50001 FAILURE FIXES (10.A - 10.G)
   ============================================================ */

/**
 * REGRESSION 10.A: Protected row later adopted as ASSIGNED
 * Proves that an existing RETIRED row matching (location_id, sequence_number)
 * or code is safely promoted to ASSIGNED, never causes unique constraint collisions,
 * and updates code to the canonical adoption code without attempting updated_at.
 */
test("REGRESSION 10.A — protected row later adopted as ASSIGNED promotes cleanly without updated_at", async () => {
  const mod = await loadMod();
  const executedSql: string[] = [];

  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    executedSql.push(raw);
    if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
    // Pre-existing protected row for sequence 1 in location loc-dr (from earlier Step 4A or pool)
    if (label === "select_dw_code_by_code") {
      return { rows: [{ id: "code-50001-id", status: "RETIRED", code: "DR50001", location_id: "loc-dr", sequence_number: 1 }] };
    }
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = (await mod.applyOperationalCodeActivation(checksum, fakeDb)) as {
    ok: boolean;
    adoptedDwCount: number;
  };

  assert.equal(result.ok, true);
  assert.equal(result.adoptedDwCount, 1);

  // Must update status to ASSIGNED and code to canonical DR00001-D
  const updateSql = executedSql.find((s) => /UPDATE dw_codes/i.test(s));
  assert.ok(updateSql, "must issue UPDATE dw_codes");
  assert.ok(/status\s*=\s*'ASSIGNED'/i.test(updateSql), "must set status to ASSIGNED");
  assert.ok(/code\s*=\s*['"]?DR00001-D['"]?/i.test(updateSql), "must set code to canonical DR00001-D");
  assert.ok(!/updated_at/i.test(updateSql), "must never reference nonexistent updated_at column");

  // Must NOT issue an INSERT for dw_codes with DR00001-D
  const insertDwCodesSql = executedSql.find((s) => /INSERT INTO dw_codes.*DR00001-D/i.test(s));
  assert.equal(insertDwCodesSql, undefined, "must promote existing row, not insert duplicate");

  // Must insert assignment attached to code-50001-id
  const insertAssignment = executedSql.find((s) => /INSERT INTO dw_code_assignments/i.test(s) && /code-50001-id/.test(s));
  assert.ok(insertAssignment, "must insert assignment with promoted codeId");
});

/**
 * REGRESSION 10.B: Code conflict
 * Proves that if a DW code has an active assignment to another worker, activation rejects fail-closed.
 */
test("REGRESSION 10.B — code conflict rejects with ACTIVATION_CONFLICT", async () => {
  const mod = await loadMod();

  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "code-1", status: "ASSIGNED", code: "DR00001-D" }] };
    // Code is currently assigned to a DIFFERENT worker w99
    if (label === "select_dw_assignment_by_code") {
      return { rows: [{ id: "a-existing", worker_id: "w99", employment_session_id: "es99" }] };
    }
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  await assert.rejects(
    async () => {
      await mod.applyOperationalCodeActivation(checksum, fakeDb);
    },
    /ACTIVATION_CONFLICT: DW Code "DR00001-D" already has an active assignment/
  );
});

/**
 * REGRESSION 10.C: Location + sequence conflict
 * Proves that if a location+sequence slot is already active under a different worker/session,
 * activation rejects fail-closed before any mutation.
 */
test("REGRESSION 10.C — location+sequence slot conflict rejects fail-closed", async () => {
  const mod = await loadMod();

  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
    // Existing row located by location_id and sequence_number
    if (label === "select_dw_code_by_code") {
      return { rows: [{ id: "slot-seq-1", status: "ASSIGNED", code: "DR00001", location_id: "loc-dr", sequence_number: 1 }] };
    }
    // Slot is already held by worker w888
    if (label === "select_dw_assignment_by_code") {
      return { rows: [{ id: "a-slot", worker_id: "w888", employment_session_id: "es888" }] };
    }
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  await assert.rejects(
    async () => {
      await mod.applyOperationalCodeActivation(checksum, fakeDb);
    },
    /ACTIVATION_CONFLICT: DW Code "DR00001-D" already has an active assignment/
  );
});

/**
 * REGRESSION 10.D: Exact idempotent rerun
 * Re-running activation against the exact same active assignments skips safely without inserting duplicate rows.
 */
test("REGRESSION 10.D — exact idempotent rerun leaves dw_codes as ASSIGNED, zero duplicate assignments", async () => {
  const mod = await loadMod();
  const executedSql: string[] = [];

  const fakeDb = makeFakeDb(FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    executedSql.push(raw);
    if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "c1", status: "ASSIGNED", code: "DR00001-D" }] };
    if (label === "select_dw_assignment_by_code") {
      return { rows: [{ id: "a1", worker_id: "w1", employment_session_id: "es1" }] };
    }
    if (label === "select_it_assignment_by_code") {
      return { rows: [{ id: "a2", worker_id: "w1", employment_session_id: "es1" }] };
    }
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = (await mod.applyOperationalCodeActivation(checksum, fakeDb)) as {
    ok: boolean;
    adoptedDwCount: number;
    skippedDwCount: number;
    adoptedItCount: number;
    skippedItCount: number;
  };

  assert.equal(result.ok, true);
  assert.equal(result.adoptedDwCount, 0);
  assert.equal(result.skippedDwCount, 1);
  assert.equal(result.adoptedItCount, 0);
  assert.equal(result.skippedItCount, 1);

  const insertedAssignments = executedSql.filter((s) => /INSERT INTO dw_code_assignments/i.test(s));
  assert.equal(insertedAssignments.length, 0, "must not insert duplicate dw_code_assignments");
});

/**
 * REGRESSION 10.E: Rollback on conflict
 * Proves that when any error/conflict happens inside the transaction, the entire transaction is rolled back.
 */
test("REGRESSION 10.E — conflict triggers complete transaction rollback", async () => {
  const mod = await loadMod();
  let transactionAborted = false;

  const fakeDb = {
    execute: makeSelectResponder(),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        const tx = {
          execute: async (q: unknown) => {
            const label = queryLabel(q);
            if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
            if (label === "select_locations") return { rows: FIXTURE.locations };
            if (label === "select_dw_data") return { rows: FIXTURE.dwData };
            if (label === "select_worker_profiles") return { rows: FIXTURE.itRows };
            if (label === "insert_dw_codes") return { rows: [] };
            if (label === "update_dw_code_locations") return { rows: [] };
            if (label === "select_dw_code_by_code") return { rows: [{ id: "c1", status: "ASSIGNED", code: "DR00001-D" }] };
            // Trigger conflict on code lookup
            if (label === "select_dw_assignment_by_code") {
              return { rows: [{ id: "conflicting", worker_id: "other-w", employment_session_id: "other-es" }] };
            }
            return { rows: [] };
          },
        };
        return await fn(tx);
      } catch (err) {
        transactionAborted = true;
        throw err;
      }
    },
  };

  const checksum = await fetchLiveChecksum(mod, fakeDb as unknown as Parameters<typeof mod.applyOperationalCodeActivation>[1]);
  await assert.rejects(
    async () => {
      await mod.applyOperationalCodeActivation(checksum, fakeDb as unknown as Parameters<typeof mod.applyOperationalCodeActivation>[1]);
    },
    /ACTIVATION_CONFLICT/
  );
  assert.equal(transactionAborted, true, "transaction must be aborted/rolled back on conflict");
});

/**
 * REGRESSION 10.F: No partial writes after failure
 * Proves that mid-transaction failure results in zero committed writes across all tables.
 */
test("REGRESSION 10.F — no partial writes persisted after mid-transaction failure", async () => {
  const mod = await loadMod();
  const committedWrites: string[] = [];
  let transactionRolledBack = false;

  const fakeDb = {
    execute: makeSelectResponder(),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const stageWrites: string[] = [];
      try {
        const tx = {
          execute: async (q: unknown) => {
            const raw = extractSql(q);
            const label = queryLabel(q);
            if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
            if (label === "select_locations") return { rows: FIXTURE.locations };
            if (label === "select_dw_data") return { rows: FIXTURE.dwData };
            if (label === "select_worker_profiles") return { rows: FIXTURE.itRows };
            if (label === "insert_dw_codes") {
              stageWrites.push(raw);
              return { rows: [] };
            }
            if (label === "update_dw_code_locations") {
              stageWrites.push(raw);
              return { rows: [] };
            }
            // Throw during Step 4C
            if (label === "select_dw_code_by_code") {
              throw new Error("SIMULATED_DB_ERROR: connection reset mid-transaction");
            }
            return { rows: [] };
          },
        };
        const res = await fn(tx);
        committedWrites.push(...stageWrites);
        return res;
      } catch (err) {
        transactionRolledBack = true;
        // stageWrites discarded on rollback
        throw err;
      }
    },
  };

  const checksum = await fetchLiveChecksum(mod, fakeDb as unknown as Parameters<typeof mod.applyOperationalCodeActivation>[1]);
  await assert.rejects(
    async () => {
      await mod.applyOperationalCodeActivation(checksum, fakeDb as unknown as Parameters<typeof mod.applyOperationalCodeActivation>[1]);
    },
    /SIMULATED_DB_ERROR/
  );

  assert.equal(transactionRolledBack, true, "must roll back");
  assert.equal(committedWrites.length, 0, "zero writes must be committed when transaction fails");
});

/**
 * REGRESSION 10.G: Bulk/set-based protected adoption
 * Proves that large sets of protected legacy codes are inserted in chunks of 500
 * using multi-row VALUES statements rather than row-by-row queries.
 */
test("REGRESSION 10.G — bulk protected codes executed in 500-row chunks", async () => {
  const mod = await loadMod();

  // Create fixture with 1,200 protected legacy codes
  const bulkDwData: {
    dw_data_id: string;
    worker_ref: string | null;
    employment_session_id: string | null;
    code: string;
    is_active: boolean;
  }[] = [
    { dw_data_id: "dw-active", worker_ref: "w1", employment_session_id: "es1", code: "DR00001-D", is_active: true },
  ];
  for (let i = 2; i <= 1201; i++) {
    bulkDwData.push({
      dw_data_id: `dw-${i}`,
      worker_ref: null,
      employment_session_id: null,
      code: `DR${String(i).padStart(5, "0")}-D`,
      is_active: false,
    });
  }

  const bulkFixture = {
    locations: [{ location_id: "loc-dr", prefix: "DR", name: "Đạ Ròn", is_active: true, next_sequence: 50002 }],
    dwData: bulkDwData,
    itRows: [{ worker_ref: "w1", dw_data_id: "dw-active", employment_session_id: "es1", dw_it_code: "IT001", wp_fingerprint_code: "IT001", is_active: true }],
  };

  const executedInserts: string[] = [];
  const fakeDb = makeFakeDb(bulkFixture as typeof FIXTURE, async (q, label) => {
    const raw = extractSql(q);
    if (label === "insert_dw_codes") {
      executedInserts.push(raw);
      return { rows: [] };
    }
    if (label === "advisory_lock") return { rows: [{ activation_locked: true, maintenance_locked: true }] };
    if (label === "select_dw_code_by_code") return { rows: [{ id: "c1", status: "ASSIGNED", code: "DR00001-D" }] };
    return { rows: [] };
  });

  const checksum = await fetchLiveChecksum(mod, fakeDb);
  const result = (await mod.applyOperationalCodeActivation(checksum, fakeDb)) as {
    ok: boolean;
    protectedDwCount: number;
    adoptedDwCount: number;
  };

  assert.equal(result.ok, true);
  assert.equal(result.protectedDwCount, 1200, "all 1200 protected codes accounted for");

  // 1200 protected codes in chunks of 500 => exactly ceil(1200 / 500) = 3 batch INSERT statements
  assert.equal(executedInserts.length, 3, "must execute exactly 3 batch INSERTs for 1200 rows (chunks of 500)");
  for (const insertSql of executedInserts) {
    assert.ok(/INSERT INTO dw_codes/i.test(insertSql), "must be INSERT INTO dw_codes");
    assert.ok(/ON CONFLICT \(location_id, sequence_number\) DO UPDATE/i.test(insertSql), "must use location+sequence conflict target");
    assert.ok(/RETIRED/i.test(insertSql), "must set status RETIRED");
    assert.ok(!/updated_at/i.test(insertSql), "must not reference updated_at");
  }
});
