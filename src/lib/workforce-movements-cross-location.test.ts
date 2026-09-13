import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDbWithTx, drizzleStub, makeTable, eqValue, argOf, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/**
 * PRE-MIGRATION INDEPENDENT REVIEW (2026-09-13) — item #1: cross-location transfer DW Code
 * lifecycle. Runs the REAL workforce-movements.ts (finalizeTransferEffect ->
 * applyCrossLocationDwCodeTransfer) composed with the REAL dw-code-pool.ts (allocateDwCode/
 * releaseDwCode), against one shared fake db, so the actual reuse/release/history logic
 * executes end to end — not a mocked call-count assertion.
 *
 * Fixture: worker w1 holds an ACTIVE assignment for code DR00003-D (location "Đông Rồng").
 *   - d1/d2 are both "Đông Rồng" (same location) — d1 -> d2 transfer must NOT touch the code.
 *   - d3 is "Sài Gòn" (different location) — d1 -> d3 transfer must release DR00003-D (back to
 *     AVAILABLE, reusable) and assign a fresh SG code.
 */

const workforceMovements = makeTable("workforce_movements");
const employmentSessions = makeTable("employment_sessions");
const dailyApplications = makeTable("daily_applications");
const departments = makeTable("departments");
const dwCodeLocations = makeTable("dw_code_locations");
const dwCodes = makeTable("dw_codes");
const dwCodeAssignments = makeTable("dw_code_assignments");
const dwData = makeTable("dw_data");
const schemaStub = { workforceMovements, employmentSessions, dailyApplications, departments, dwCodeLocations, dwCodes, dwCodeAssignments, dwData };

const TODAY = "2026-09-13";

type Movement = {
  id: string;
  movementType: "transfer";
  workerId: string;
  fromDeptId: string | null;
  toDeptId: string | null;
  effectiveDate: string;
  status: string;
  confirmedBy: string | null;
  confirmedAt: unknown;
  source: string | null;
  employmentSessionId: string | null;
  lifecycleAppliedAt: unknown;
  note: string | null;
  requestedBy: string;
};

function baseTransfer(overrides: Partial<Movement> = {}): Movement {
  return {
    id: "m1",
    movementType: "transfer",
    workerId: "w1",
    fromDeptId: "d1",
    toDeptId: "d3",
    effectiveDate: TODAY,
    status: "PENDING_HR",
    confirmedBy: null,
    confirmedAt: null,
    source: null,
    employmentSessionId: null,
    lifecycleAppliedAt: null,
    note: null,
    requestedBy: "manager1",
    ...overrides,
  };
}

function makeStore() {
  const movements = new Map<string, Movement>([["m1", baseTransfer()]]);
  const sessions = new Map([["s1", { id: "s1", workerId: "w1", deptId: "d1", status: "APPROVED", endDate: null as string | null, endReason: null, dailyApplicationId: "app1", regDate: "2026-01-01" }]]);
  const depts = new Map([
    ["d1", { id: "d1", location: "Đông Rồng" }],
    ["d2", { id: "d2", location: "Đông Rồng" }],
    ["d3", { id: "d3", location: "Sài Gòn" }],
  ]);
  const locations = new Map([
    ["loc-dr", { id: "loc-dr", name: "Đông Rồng", prefix: "DR", sequenceDigits: 5, separator: "-", suffix: "D", startNumber: 1, nextSequence: 4, isActive: true }],
    ["loc-sg", { id: "loc-sg", name: "Sài Gòn", prefix: "SG", sequenceDigits: 5, separator: "-", suffix: "D", startNumber: 1, nextSequence: 1, isActive: true }],
  ]);
  const codes = new Map([["code-dr-3", { id: "code-dr-3", locationId: "loc-dr", sequenceNumber: 3, code: "DR00003-D", status: "ASSIGNED" }]]);
  const assignments = new Map([
    ["assign-1", { id: "assign-1", codeId: "code-dr-3", workerId: "w1", employmentSessionId: "s1", dwDataId: "dw1", assignedBy: "hr1", releasedAt: null as Date | null, releasedBy: null as string | null, releaseReason: null as string | null }],
  ]);
  const dailyApps = new Map([["app1", { id: "app1", deptId: "d1", dwId: "dw1" }]]);
  const dws = new Map([["dw1", { id: "dw1", code: "DR00003-D" }]]);
  let assignmentSeq = 2;
  let codeSeq = 2;

  const respond = (call: QueryCall): unknown => {
    if (call.table === "workforce_movements") {
      if (call.root === "select") {
        const idEq = eqValue(call, "workforce_movements.id");
        if (idEq !== undefined) {
          const m = movements.get(idEq as string);
          return m ? [m] : [];
        }
        return [...movements.values()]
          .filter((m) => !m.lifecycleAppliedAt && m.effectiveDate <= TODAY && m.status === "TRANSFER_COMPLETED")
          .map((m) => ({ id: m.id }));
      }
      if (call.root === "update") {
        const idEq = eqValue(call, "workforce_movements.id") as string;
        const patch = argOf(call, "set") as Record<string, unknown>;
        const existing = movements.get(idEq);
        if (existing) Object.assign(existing, patch);
        return existing ? [{ ...existing }] : [];
      }
    }
    if (call.table === "employment_sessions") {
      if (call.root === "select") {
        const workerId = eqValue(call, "employment_sessions.workerId");
        return workerId ? [...sessions.values()].filter((s) => s.workerId === workerId).map((s) => ({ id: s.id, dailyApplicationId: s.dailyApplicationId })) : [];
      }
      if (call.root === "update") {
        const idEq = eqValue(call, "employment_sessions.id") as string;
        const patch = argOf(call, "set") as Record<string, unknown>;
        const existing = sessions.get(idEq);
        if (existing) Object.assign(existing, patch);
        return existing ? [{ ...existing }] : [];
      }
    }
    if (call.table === "daily_applications") {
      if (call.root === "select") {
        const idEq = eqValue(call, "daily_applications.id") as string;
        const app = dailyApps.get(idEq);
        return app ? [{ dwId: app.dwId }] : [];
      }
      if (call.root === "update") {
        const idEq = eqValue(call, "daily_applications.id") as string;
        const patch = argOf(call, "set") as Record<string, unknown>;
        const existing = dailyApps.get(idEq);
        if (existing) Object.assign(existing, patch);
        return existing ? [{ ...existing }] : [];
      }
    }
    if (call.table === "departments" && call.root === "select") {
      const idEq = eqValue(call, "departments.id") as string;
      const dept = depts.get(idEq);
      return dept ? [{ location: dept.location }] : [];
    }
    if (call.table === "dw_code_locations") {
      if (call.root === "select") {
        const whereArg = call.ops.find((o) => o.fn === "where")?.args[0] as { op: string; values?: unknown[] } | undefined;
        if (whereArg?.op === "sql") {
          // applyCrossLocationDwCodeTransfer's name-match lookup: `sql`lower(trim(name)) = lower(trim(${toLocation}))``.
          const targetName = String(whereArg.values?.[1] ?? "").trim().toLowerCase();
          const match = [...locations.values()].find((l) => l.name.trim().toLowerCase() === targetName);
          return match ? [{ id: match.id, isActive: match.isActive }] : [];
        }
        // allocateDwCode's blind full-row lookup by id.
        const idEq = eqValue(call, "dw_code_locations.id") as string;
        const loc = locations.get(idEq);
        return loc ? [{ ...loc }] : [];
      }
      if (call.root === "update") {
        const idEq = eqValue(call, "dw_code_locations.id") as string;
        const patch = argOf(call, "set") as Record<string, unknown>;
        const loc = locations.get(idEq);
        const usedSequence = loc ? loc.nextSequence : 0;
        if (loc && typeof patch.nextSequence !== "undefined") loc.nextSequence += 1;
        return [{ usedSequence }];
      }
    }
    if (call.table === "dw_code_assignments") {
      if (call.root === "select") {
        const workerEq = eqValue(call, "dw_code_assignments.workerId");
        if (workerEq !== undefined) {
          const active = [...assignments.values()].find((a) => a.workerId === workerEq && !a.releasedAt);
          return active ? [{ id: active.id }] : [];
        }
        const sessionEq = eqValue(call, "dw_code_assignments.employmentSessionId");
        if (sessionEq !== undefined) {
          const active = [...assignments.values()].find((a) => a.employmentSessionId === sessionEq && !a.releasedAt);
          return active ? [{ id: active.id, codeId: active.codeId, dwDataId: active.dwDataId }] : [];
        }
        return [];
      }
      if (call.root === "insert") {
        const values = argOf(call, "values") as Record<string, unknown>;
        const id = `assign-${assignmentSeq++}`;
        assignments.set(id, { id, codeId: values.codeId as string, workerId: values.workerId as string, employmentSessionId: values.employmentSessionId as string, dwDataId: values.dwDataId as string, assignedBy: values.assignedBy as string, releasedAt: null, releasedBy: null, releaseReason: null });
        return [{ id }];
      }
      if (call.root === "update") {
        const idEq = eqValue(call, "dw_code_assignments.id") as string;
        const patch = argOf(call, "set") as Record<string, unknown>;
        const existing = assignments.get(idEq);
        if (existing) Object.assign(existing, patch);
        return existing ? [{ ...existing }] : [];
      }
    }
    if (call.table === "dw_codes") {
      if (call.root === "select") {
        const locEq = eqValue(call, "dw_codes.locationId");
        const statusEq = eqValue(call, "dw_codes.status");
        if (locEq !== undefined) {
          const reusable = [...codes.values()]
            .filter((c) => c.locationId === locEq && c.status === (statusEq ?? "AVAILABLE"))
            .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];
          return reusable ? [{ ...reusable }] : [];
        }
        return [];
      }
      if (call.root === "insert") {
        const values = argOf(call, "values") as Record<string, unknown>;
        const id = `code-${codeSeq++}`;
        codes.set(id, { id, locationId: values.locationId as string, sequenceNumber: values.sequenceNumber as number, code: values.code as string, status: values.status as string });
        return [{ id }];
      }
      if (call.root === "update") {
        const idEq = eqValue(call, "dw_codes.id") as string;
        const patch = argOf(call, "set") as Record<string, unknown>;
        const existing = codes.get(idEq);
        if (existing) Object.assign(existing, patch);
        return existing ? [{ code: existing?.code }] : [];
      }
    }
    if (call.table === "dw_data" && call.root === "update") {
      const idEq = eqValue(call, "dw_data.id") as string;
      const patch = argOf(call, "set") as Record<string, unknown>;
      const existing = dws.get(idEq);
      if (existing) Object.assign(existing, patch);
      return existing ? [{ ...existing }] : [];
    }
    return undefined;
  };

  const { db } = createFakeDbWithTx({ respond });
  return { db, movements, sessions, depts, locations, codes, assignments, dailyApps, dws };
}

async function loadWith(store: ReturnType<typeof makeStore>) {
  const dwCodePoolMod = loadModule(new URL("./dw-code-pool.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db: store.db },
      "@/db/schema": schemaStub,
    },
  });

  const mod = loadModule(new URL("./workforce-movements.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db: store.db },
      "@/db/schema": schemaStub,
      "@/lib/notifications": { queueNotification: async () => undefined },
      "@/lib/planning": { autoAllocateInternship: async () => undefined },
      "@/lib/workforce-request": {
        endActiveRequestAllocationsForWorker: async () => ({ affectedRequestIds: [] }),
        endActiveRequestAllocationsForTransfer: async () => ({ affectedRequestIds: [] }),
      },
      "@/lib/recruitment-kpi": { recomputeStoredRecruitmentBalance: async () => undefined },
      "@/lib/dw-code-pool": dwCodePoolMod,
      "@/lib/it-code-assignment": { releaseItCode: async () => ({ released: false, itCode: null }) },
      "@/lib/helpers": { todayStr: () => TODAY },
    },
  });
  return mod as unknown as {
    applyMovementAction: (session: { username: string; id: string; role: string }, id: string, action: string, extra?: Record<string, unknown>) => Promise<{ movement: Movement }>;
    applyEffectiveWorkforceMovements: (asOf?: string) => Promise<{ transfersApplied: number }>;
  };
}

const ACTOR = { username: "hr1", id: "u1", role: "HR_RECRUITER" };

test("same-location transfer (d1 -> d2, both Đông Rồng) keeps the worker's DW Code untouched", async () => {
  const store = makeStore();
  store.movements.get("m1")!.toDeptId = "d2";
  const mod = await loadWith(store);

  await mod.applyMovementAction(ACTOR, "m1", "CONFIRM_ARRIVED");

  const assignment = store.assignments.get("assign-1")!;
  assert.equal(assignment.releasedAt, null, "same-location transfer must NOT release the existing code");
  assert.equal(store.codes.get("code-dr-3")!.status, "ASSIGNED");
  assert.equal(store.assignments.size, 1, "no new assignment should be created for a same-location transfer");
});

test("cross-location transfer (d1 -> d3, Đông Rồng -> Sài Gòn) releases the old code and assigns a destination-location code", async () => {
  const store = makeStore();
  const mod = await loadWith(store);

  await mod.applyMovementAction(ACTOR, "m1", "CONFIRM_ARRIVED");

  const oldAssignment = store.assignments.get("assign-1")!;
  assert.ok(oldAssignment.releasedAt, "old DR code assignment must be released");
  assert.equal(oldAssignment.releaseReason, "CROSS_LOCATION_TRANSFER");
  assert.equal(store.codes.get("code-dr-3")!.status, "AVAILABLE", "the old code must become reusable (AVAILABLE), never RETIRED");

  const newAssignment = [...store.assignments.values()].find((a) => a.id !== "assign-1")!;
  assert.ok(newAssignment, "a new assignment for the destination-location code must be created");
  assert.equal(newAssignment.releasedAt, null);
  const newCode = store.codes.get(newAssignment.codeId)!;
  assert.equal(newCode.code, "SG00001-D", "new code must use the destination location's own prefix/sequence");
  assert.equal(store.dws.get("dw1")!.code, "SG00001-D", "dw_data.code mirror must reflect the new destination code");
});

test("a FUTURE-dated cross-location transfer does not swap the code early — only when it actually becomes effective", async () => {
  const store = makeStore();
  store.movements.get("m1")!.effectiveDate = "2026-12-25";
  const mod = await loadWith(store);

  const { movement } = await mod.applyMovementAction(ACTOR, "m1", "CONFIRM_ARRIVED");
  assert.equal(movement.lifecycleAppliedAt, null, "future transfer must not apply its lifecycle effect yet");

  const assignment = store.assignments.get("assign-1")!;
  assert.equal(assignment.releasedAt, null, "code must remain untouched until the transfer's effective date arrives");
  assert.equal(store.assignments.size, 1);
});

test("MISSION F section 18 fix — transfer to a destination location with NO dw_code_locations config at all must NOT release the old code (no partial state)", async () => {
  const store = makeStore();
  store.depts.set("d4", { id: "d4", location: "Lâm Hà" }); // no matching dw_code_locations row anywhere in `store.locations`
  store.movements.get("m1")!.toDeptId = "d4";
  const mod = await loadWith(store);

  await mod.applyMovementAction(ACTOR, "m1", "CONFIRM_ARRIVED");

  const assignment = store.assignments.get("assign-1")!;
  assert.equal(assignment.releasedAt, null, "old code must remain ACTIVE — destination has no code namespace to receive a new one");
  assert.equal(store.codes.get("code-dr-3")!.status, "ASSIGNED", "old code must NOT be returned to the pool");
  assert.equal(store.assignments.size, 1, "no new assignment may be created either");
});

test("MISSION F section 18 fix — transfer to a destination location whose config exists but is INACTIVE must NOT release the old code", async () => {
  const store = makeStore();
  store.depts.set("d4", { id: "d4", location: "Lâm Hà" });
  store.locations.set("loc-lh", { id: "loc-lh", name: "Lâm Hà", prefix: "LH", sequenceDigits: 5, separator: "-", suffix: "D", startNumber: 1, nextSequence: 1, isActive: false });
  store.movements.get("m1")!.toDeptId = "d4";
  const mod = await loadWith(store);

  await mod.applyMovementAction(ACTOR, "m1", "CONFIRM_ARRIVED");

  const assignment = store.assignments.get("assign-1")!;
  assert.equal(assignment.releasedAt, null, "old code must remain ACTIVE — destination namespace is configured but INACTIVE");
  assert.equal(store.codes.get("code-dr-3")!.status, "ASSIGNED");
  assert.equal(store.assignments.size, 1);
});

test("retrying applyEffectiveWorkforceMovements for an already-applied cross-location transfer does not release/assign twice", async () => {
  const store = makeStore();
  store.movements.get("m1")!.status = "TRANSFER_COMPLETED";
  const mod = await loadWith(store);

  const first = await mod.applyEffectiveWorkforceMovements(TODAY);
  assert.equal(first.transfersApplied, 1);
  assert.equal(store.assignments.size, 2, "exactly one release + one new assignment after the first (real) application");

  const second = await mod.applyEffectiveWorkforceMovements(TODAY);
  assert.equal(second.transfersApplied, 0, "the scheduler's own lifecycleAppliedAt guard must skip an already-applied movement entirely");
  assert.equal(store.assignments.size, 2, "a retry must never create a duplicate release or a duplicate new assignment");
});
