import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/**
 * MISSION F — dry-run activation planner (src/lib/operational-code-activation.ts).
 * Proves the P1 bootstrap-safety guarantee (mission section 3/33/34): a legacy code already in
 * active use must NEVER be classified as adoptable/safe by this planner, and a location whose
 * nextSequence would collide with legacy history must be BLOCKED, not silently READY.
 */

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
      locationReadiness: { locationId: string; state: string }[];
      dwAdoptions: { workerRef: string; code: string }[];
      dwProtectedCodes: { code: string }[];
      itAdoptions: { workerRef: string; itCode: string }[];
      conflicts: { type: string; workerRefs: string[] }[];
      checksum: string;
    };
    prepareOperationalCodeActivation: (opts: { dryRun: true }, executor: unknown) => Promise<unknown>;
    applyOperationalCodeActivation: (checksum: string) => Promise<never>;
  };
}

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

test("applyOperationalCodeActivation is NOT IMPLEMENTED — always throws, never writes (mission section 25 — design but do not execute)", async () => {
  const mod = await loadMod();
  await assert.rejects(() => mod.applyOperationalCodeActivation("any-checksum"), /NOT IMPLEMENTED/);
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
