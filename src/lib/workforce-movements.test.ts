import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, eqValue, argOf, type FakeDb, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/**
 * EFFECTIVE-DATE LIFECYCLE (Worker Lifecycle Consistency audit, 2026-09-10) — proves the REAL
 * source (workforce-movements.ts) against a fake db that models just enough state (one
 * employment session per worker, one workforce_movements row per test) to assert:
 *
 *   - APPROVE_RESIGNATION/CONFIRM_ARRIVED with effectiveDate <= "today" applies the workforce
 *     effect IMMEDIATELY (session ended / department moved) and stamps lifecycleAppliedAt.
 *   - the SAME actions with a FUTURE effectiveDate record the HR decision (status/confirmedBy)
 *     but do NOT touch employment_sessions — lifecycleAppliedAt stays NULL.
 *   - applyEffectiveWorkforceMovements(asOf) applies exactly the movements that are due
 *     (lifecycleAppliedAt NULL, effectiveDate <= asOf, terminal status) and is idempotent — a
 *     second run against the same (now-applied) data touches nothing again.
 *   - transfer moves deptId on the SAME session (never ends it) — resignation ends the session
 *     (never just changes deptId) — the two lifecycles never cross-contaminate.
 *
 * "today" is injected via a stubbed @/lib/helpers so tests never depend on the real wall clock.
 */

const workforceMovements = makeTable("workforce_movements");
const employmentSessions = makeTable("employment_sessions");
const dailyApplications = makeTable("daily_applications");
const schemaStub = { workforceMovements, employmentSessions, dailyApplications };

const TODAY = "2026-09-10";

type Movement = {
  id: string;
  movementType: "resignation" | "transfer";
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

type Session = {
  id: string;
  workerId: string;
  deptId: string | null;
  status: string;
  endDate: string | null;
  endReason: string | null;
  dailyApplicationId: string | null;
  regDate: string;
};

function makeStore(movement: Movement, session: Session) {
  const movements = new Map<string, Movement>([[movement.id, { ...movement }]]);
  const sessions = new Map<string, Session>([[session.id, { ...session }]]);
  const writes: { table: string; id: string; patch: Record<string, unknown> }[] = [];
  const allocCalls: unknown[] = [];
  const autoAllocateCalls: unknown[] = [];

  const respond = (call: QueryCall): unknown => {
    if (call.table === "workforce_movements") {
      if (call.root === "select") {
        const idEq = eqValue(call, "workforce_movements.id");
        if (idEq !== undefined) {
          const m = movements.get(idEq as string);
          return m ? [m] : [];
        }
        // Due-scan (applyEffectiveWorkforceMovements): only `id` projected, filtered by
        // lifecycleAppliedAt IS NULL + effectiveDate <= asOf + status IN (terminal).
        return [...movements.values()]
          .filter((m) => !m.lifecycleAppliedAt && m.effectiveDate <= TODAY && (m.status === "INACTIVE" || m.status === "TRANSFER_COMPLETED"))
          .map((m) => ({ id: m.id }));
      }
      if (call.root === "update") {
        const idEq = eqValue(call, "workforce_movements.id") as string;
        const patch = argOf(call, "set") as Record<string, unknown>;
        const existing = movements.get(idEq);
        if (existing) Object.assign(existing, patch);
        writes.push({ table: "workforce_movements", id: idEq, patch });
        return existing ? [{ ...existing }] : [];
      }
    }
    if (call.table === "employment_sessions") {
      if (call.root === "select") {
        const workerId = eqValue(call, "employment_sessions.workerId");
        const idEq = eqValue(call, "employment_sessions.id");
        const match = idEq !== undefined ? sessions.get(idEq as string) : [...sessions.values()].find((s) => s.workerId === workerId);
        return match ? [match] : [];
      }
      if (call.root === "update") {
        const idEq = eqValue(call, "employment_sessions.id") as string;
        const patch = argOf(call, "set") as Record<string, unknown>;
        const existing = sessions.get(idEq);
        if (existing) Object.assign(existing, patch);
        writes.push({ table: "employment_sessions", id: idEq, patch });
        return existing ? [{ ...existing }] : [];
      }
    }
    return undefined;
  };

  const db = createFakeDb({ respond });
  return { db, movements, sessions, writes, allocCalls, autoAllocateCalls };
}

async function loadWith(store: ReturnType<typeof makeStore>) {
  const mod = loadModule(new URL("./workforce-movements.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db: store.db },
      "@/db/schema": schemaStub,
      "@/lib/notifications": { queueNotification: async () => undefined },
      "@/lib/planning": {
        autoAllocateInternship: async (...args: unknown[]) => {
          store.autoAllocateCalls.push(args);
        },
      },
      "@/lib/workforce-request": {
        endActiveRequestAllocationsForWorker: async (...args: unknown[]) => {
          store.allocCalls.push(args);
          return { affectedRequestIds: [] };
        },
      },
      "@/lib/recruitment-kpi": { recomputeStoredRecruitmentBalance: async () => undefined },
      "@/lib/helpers": { todayStr: () => TODAY },
    },
  });
  return mod as unknown as {
    applyMovementAction: (session: { username: string; id: string; role: string }, id: string, action: string, extra?: Record<string, unknown>) => Promise<{ movement: Movement; spawnedResignationId: string | null }>;
    applyEffectiveWorkforceMovements: (asOf?: string) => Promise<{ checked: number; resignationsApplied: number; transfersApplied: number; appliedIds: string[] }>;
  };
}

const ACTOR = { username: "hr1", id: "u1", role: "HR_RECRUITER" };

function baseResignation(overrides: Partial<Movement> = {}): Movement {
  return {
    id: "m1",
    movementType: "resignation",
    workerId: "w1",
    fromDeptId: "d1",
    toDeptId: null,
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

function baseTransfer(overrides: Partial<Movement> = {}): Movement {
  return {
    id: "m1",
    movementType: "transfer",
    workerId: "w1",
    fromDeptId: "d1",
    toDeptId: "d2",
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

function activeSession(overrides: Partial<Session> = {}): Session {
  return { id: "s1", workerId: "w1", deptId: "d1", status: "APPROVED", endDate: null, endReason: null, dailyApplicationId: null, regDate: "2026-01-01", ...overrides };
}

test("RESIGNATION — approved with effectiveDate in the PAST -> applied immediately: session ENDED, lifecycleAppliedAt set", async () => {
  const store = makeStore(baseResignation({ effectiveDate: "2026-09-01" }), activeSession());
  const mod = await loadWith(store);
  const { movement } = await mod.applyMovementAction(ACTOR, "m1", "APPROVE_RESIGNATION");
  assert.equal(movement.status, "INACTIVE");
  assert.ok(movement.lifecycleAppliedAt, "lifecycleAppliedAt must be set — effective date already passed");
  assert.equal(store.sessions.get("s1")!.status, "ENDED");
  assert.equal(store.sessions.get("s1")!.endDate, "2026-09-01");
  assert.equal(store.allocCalls.length, 1, "allocation cleanup must run for an immediately-effective resignation");
});

test("RESIGNATION — approved with effectiveDate TODAY -> applied immediately (today counts as effective)", async () => {
  const store = makeStore(baseResignation({ effectiveDate: TODAY }), activeSession());
  const mod = await loadWith(store);
  const { movement } = await mod.applyMovementAction(ACTOR, "m1", "APPROVE_RESIGNATION");
  assert.ok(movement.lifecycleAppliedAt);
  assert.equal(store.sessions.get("s1")!.status, "ENDED");
});

test("RESIGNATION — approved with a FUTURE effectiveDate -> decision recorded, but session stays ACTIVE (lifecycleAppliedAt NULL, 'Sắp nghỉ')", async () => {
  const store = makeStore(baseResignation({ effectiveDate: "2026-09-20" }), activeSession());
  const mod = await loadWith(store);
  const { movement } = await mod.applyMovementAction(ACTOR, "m1", "APPROVE_RESIGNATION");
  assert.equal(movement.status, "INACTIVE", "the HR decision (request status) is still recorded immediately");
  assert.equal(movement.confirmedBy, "hr1");
  assert.equal(movement.lifecycleAppliedAt, null, "not yet applied — effective date is in the future");
  assert.equal(store.sessions.get("s1")!.status, "APPROVED", "session must remain untouched (worker stays ACTIVE) until the effective date");
  assert.equal(store.sessions.get("s1")!.endDate, null);
  assert.equal(store.allocCalls.length, 0, "no allocation cleanup yet — nothing has taken effect");
});

test("applyEffectiveWorkforceMovements — applies a resignation whose effective date has now arrived, exactly once", async () => {
  const store = makeStore(
    baseResignation({ effectiveDate: TODAY, status: "INACTIVE", confirmedBy: "hr1", lifecycleAppliedAt: null }),
    activeSession(),
  );
  const mod = await loadWith(store);
  const result = await mod.applyEffectiveWorkforceMovements(TODAY);
  assert.equal(result.resignationsApplied, 1);
  assert.equal(store.sessions.get("s1")!.status, "ENDED");
  assert.ok(store.movements.get("m1")!.lifecycleAppliedAt);

  // Idempotency: running it again must be a no-op (already applied).
  const secondRun = await mod.applyEffectiveWorkforceMovements(TODAY);
  assert.equal(secondRun.resignationsApplied, 0);
  assert.equal(secondRun.checked, 0, "an already-applied movement must not even be re-scanned as due");
});

test("applyEffectiveWorkforceMovements — a movement with a FUTURE effective date is never picked up", async () => {
  const store = makeStore(
    baseResignation({ effectiveDate: "2026-12-25", status: "INACTIVE", lifecycleAppliedAt: null }),
    activeSession(),
  );
  const mod = await loadWith(store);
  const result = await mod.applyEffectiveWorkforceMovements(TODAY);
  assert.equal(result.checked, 0);
  assert.equal(store.sessions.get("s1")!.status, "APPROVED", "must remain untouched — not due yet");
});

test("TRANSFER — approved with effectiveDate in the PAST -> department moved immediately on the SAME session (never ended)", async () => {
  const store = makeStore(baseTransfer({ effectiveDate: "2026-09-01" }), activeSession());
  const mod = await loadWith(store);
  const { movement } = await mod.applyMovementAction(ACTOR, "m1", "CONFIRM_ARRIVED");
  assert.equal(movement.status, "TRANSFER_COMPLETED");
  assert.ok(movement.lifecycleAppliedAt);
  assert.equal(store.sessions.get("s1")!.deptId, "d2");
  assert.equal(store.sessions.get("s1")!.status, "APPROVED", "transfer must never end the session");
  assert.equal(store.autoAllocateCalls.length, 1);
});

test("TRANSFER — approved with a FUTURE effectiveDate -> department stays OLD until effective ('Sắp chuyển')", async () => {
  const store = makeStore(baseTransfer({ effectiveDate: "2026-09-25" }), activeSession());
  const mod = await loadWith(store);
  const { movement } = await mod.applyMovementAction(ACTOR, "m1", "CONFIRM_ARRIVED");
  assert.equal(movement.status, "TRANSFER_COMPLETED");
  assert.equal(movement.lifecycleAppliedAt, null);
  assert.equal(store.sessions.get("s1")!.deptId, "d1", "must still show the OLD department until effectiveDate arrives");
  assert.equal(store.autoAllocateCalls.length, 0);
});

test("applyEffectiveWorkforceMovements — applies a due transfer exactly once (idempotent repeat)", async () => {
  const store = makeStore(
    baseTransfer({ effectiveDate: TODAY, status: "TRANSFER_COMPLETED", lifecycleAppliedAt: null }),
    activeSession(),
  );
  const mod = await loadWith(store);
  const first = await mod.applyEffectiveWorkforceMovements(TODAY);
  assert.equal(first.transfersApplied, 1);
  assert.equal(store.sessions.get("s1")!.deptId, "d2");
  assert.equal(store.autoAllocateCalls.length, 1);

  const second = await mod.applyEffectiveWorkforceMovements(TODAY);
  assert.equal(second.transfersApplied, 0);
  assert.equal(store.autoAllocateCalls.length, 1, "must not re-run autoAllocateInternship a second time");
});

test("REJECT — never touches employment_sessions regardless of effective date", async () => {
  const store = makeStore(baseResignation({ effectiveDate: "2026-09-01" }), activeSession());
  const mod = await loadWith(store);
  const { movement } = await mod.applyMovementAction(ACTOR, "m1", "REJECT");
  assert.equal(movement.status, "REJECTED");
  assert.equal(store.sessions.get("s1")!.status, "APPROVED");
  assert.equal(store.allocCalls.length, 0);
});

/**
 * PRODUCTION HARDENING (2026-09-10, defense-in-depth) — this incident's root cause
 * (worker-360-profile.ts, "Lỗi tải hồ sơ") was a blind db.select() (no column list) on
 * workforce_movements: it selects EVERY column schema.ts declares, so if Production's real
 * table is ever missing one (schema/DB drift), the WHOLE query throws — not just the missing
 * field. applyMovementAction()/applyEffectiveWorkforceMovements() and the finalize*Effect()
 * helpers they call read workforce_movements/employment_sessions the same way; this guard
 * proves every select() reached during a real exercised code path passes an explicit column
 * projection, never a blind select().
 */
function assertNoBlindSelects(calls: QueryCall[]): void {
  for (const call of calls) {
    if (call.root !== "select") continue;
    if (call.table !== "workforce_movements" && call.table !== "employment_sessions") continue;
    const selectOp = call.ops[0];
    const firstArg = selectOp?.args[0];
    assert.ok(
      firstArg !== undefined && typeof firstArg === "object" && firstArg !== null,
      `blind db.select() (no column projection) on ${call.table} — selects every column schema.ts declares, the exact pattern that caused the "Lỗi tải hồ sơ" incident`,
    );
  }
}

test("GUARD — APPROVE_RESIGNATION (immediate effect) never issues a blind select() on workforce_movements/employment_sessions", async () => {
  const store = makeStore(baseResignation({ effectiveDate: "2026-09-01" }), activeSession());
  const mod = await loadWith(store);
  await mod.applyMovementAction(ACTOR, "m1", "APPROVE_RESIGNATION");
  assertNoBlindSelects(store.db.calls);
});

test("GUARD — CONFIRM_ARRIVED (immediate effect) never issues a blind select() on workforce_movements/employment_sessions", async () => {
  const store = makeStore(baseTransfer({ effectiveDate: "2026-09-01" }), activeSession());
  const mod = await loadWith(store);
  await mod.applyMovementAction(ACTOR, "m1", "CONFIRM_ARRIVED");
  assertNoBlindSelects(store.db.calls);
});

test("GUARD — applyEffectiveWorkforceMovements() never issues a blind select() on workforce_movements/employment_sessions", async () => {
  const store = makeStore(baseResignation({ status: "INACTIVE", effectiveDate: "2026-09-01", confirmedBy: "hr1" }), activeSession());
  const mod = await loadWith(store);
  await mod.applyEffectiveWorkforceMovements();
  assertNoBlindSelects(store.db.calls);
});
