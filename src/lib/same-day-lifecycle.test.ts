import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, eqValue, argOf, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/**
 * MISSION E — same-day non-start/early-leave lifecycle (sections 9-21, 43-46).
 * Runs the REAL src/lib/same-day-lifecycle.ts against a fake db + stubbed
 * cross-module primitives (finalizeResignationEffect, endActiveRequestAllocationsForWorker,
 * releaseDwCode, releaseItCode, excludeFromMeal, queueNotification, writeAudit) so each
 * test can assert exactly what the orchestration does/does not touch, per outcome:
 *   - NO_SHOW / DECLINED_AT_START: ends the session directly, NEVER creates a
 *     workforce_movements row, NEVER calls finalizeResignationEffect (must not count as Quit).
 *   - STARTED_THEN_LEFT: creates a real resignation workforce_movements row and reuses
 *     the canonical finalizeResignationEffect() — same Quit-counting engine as normal HR
 *     resignation approval.
 *   - idempotent double-submit: second call against an already-ended session with an
 *     existing same_day_lifecycle_events row replays the previous result, no new writes.
 *   - OUT_OF_SCOPE / NO_ACTIVE_SESSION guard rails.
 */

const employmentSessions = makeTable("employment_sessions");
const dailyApplications = makeTable("daily_applications");
const sameDayLifecycleEvents = makeTable("same_day_lifecycle_events");
const workforceMovements = makeTable("workforce_movements");
const schemaStub = { employmentSessions, dailyApplications, sameDayLifecycleEvents, workforceMovements };

const TODAY = "2026-09-13";
const SESSION = {
  id: "sess-1",
  workerId: "worker-1",
  deptId: "dept-1",
  dailyApplicationId: "app-1",
  status: "APPROVED",
  endDate: null as string | null,
  regDate: "2026-09-13",
  createdAt: new Date("2026-09-13T00:00:00Z"),
};
const APP = { id: "app-1", regDate: "2026-09-13" };

function makeStore(opts: { activeSession: typeof SESSION | null; mostRecentSession?: typeof SESSION | null; existingEvent?: Record<string, unknown> | null }) {
  const writes: { table: string; patch: unknown }[] = [];
  const inserted: { table: string; values: unknown }[] = [];
  const calls = { finalizeResignation: 0, endAllocations: 0, recompute: 0, releaseDw: 0, releaseIt: 0, excludeMeal: 0, notify: 0, audit: 0 };

  const respond = (call: QueryCall): unknown => {
    if (call.table === "employment_sessions") {
      if (call.root === "select") {
        const statusEq = eqValue(call, "employment_sessions.status");
        if (statusEq === "APPROVED") {
          // True ACTIVE-session lookup.
          return opts.activeSession ? [opts.activeSession] : [];
        }
        // Fallback "most recent session" lookup (no status filter).
        return opts.mostRecentSession ? [opts.mostRecentSession] : opts.activeSession ? [opts.activeSession] : [];
      }
      if (call.root === "update") {
        const patch = argOf(call, "set");
        writes.push({ table: "employment_sessions", patch });
        return [{ ...SESSION, ...(patch as object) }];
      }
    }
    if (call.table === "daily_applications" && call.root === "select") {
      return [APP];
    }
    if (call.table === "same_day_lifecycle_events") {
      if (call.root === "select") {
        return opts.existingEvent ? [opts.existingEvent] : [];
      }
      if (call.root === "insert") {
        const values = argOf(call, "values");
        inserted.push({ table: "same_day_lifecycle_events", values });
        return [{ id: "event-new" }];
      }
    }
    if (call.table === "workforce_movements") {
      if (call.root === "insert") {
        const values = argOf(call, "values");
        inserted.push({ table: "workforce_movements", values });
        return [{ id: "movement-1", ...(values as object) }];
      }
      if (call.root === "update") {
        const patch = argOf(call, "set");
        writes.push({ table: "workforce_movements", patch });
        return [{}];
      }
    }
    return undefined;
  };

  const db = createFakeDb({ respond });
  return { db, writes, inserted, calls };
}

async function loadWith(store: ReturnType<typeof makeStore>) {
  const mod = loadModule(new URL("./same-day-lifecycle.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db: store.db },
      "@/db/schema": schemaStub,
      "@/lib/workforce-movements": {
        finalizeResignationEffect: async () => {
          store.calls.finalizeResignation += 1;
        },
      },
      "@/lib/workforce-request": {
        endActiveRequestAllocationsForWorker: async () => {
          store.calls.endAllocations += 1;
          return { affectedRequestIds: ["rq-1"] };
        },
      },
      "@/lib/recruitment-kpi": {
        recomputeStoredRecruitmentBalance: async () => {
          store.calls.recompute += 1;
        },
      },
      "@/lib/dw-code-pool": {
        releaseDwCode: async () => {
          store.calls.releaseDw += 1;
          return { released: true, code: "DR00001-D" };
        },
      },
      "@/lib/it-code-assignment": {
        releaseItCode: async () => {
          store.calls.releaseIt += 1;
          return { released: true, itCode: "IT001" };
        },
      },
      "@/lib/meal-cutoff": {
        excludeFromMeal: async () => {
          store.calls.excludeMeal += 1;
          return { outcome: "CANCELLED_BEFORE_CUTOFF" };
        },
      },
      "@/lib/helpers": { todayStr: () => TODAY },
      "@/lib/notifications": {
        queueNotification: async () => {
          store.calls.notify += 1;
        },
      },
      "@/lib/auth": {
        writeAudit: async () => {
          store.calls.audit += 1;
        },
      },
    },
  });
  return mod as unknown as {
    applySameDayLifecycleEvent: (input: {
      workerId: string;
      outcome: "NO_SHOW" | "DECLINED_AT_START" | "STARTED_THEN_LEFT";
      eventAt: Date;
      reason?: string | null;
      session: { username: string; id: string; role: string };
      scope: string[] | null;
    }) => Promise<
      | { ok: true; alreadyApplied: boolean; eventId: string; mealAction: string; dwCodeReleased: boolean; itCodeReleased: boolean }
      | { ok: false; error: string }
    >;
    outcomeLabel: (o: string) => string;
  };
}

const ACTOR = { username: "manager1", id: "u1", role: "DEPT_MANAGER" };

test("NO_SHOW ends the session directly, never touches workforce_movements, never counts as Quit", async () => {
  const store = makeStore({ activeSession: SESSION });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    reason: null,
    session: ACTOR,
    scope: ["dept-1"],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.alreadyApplied, false);
  assert.equal(store.calls.finalizeResignation, 0, "NO_SHOW must NOT reuse the resignation Quit-counting engine");
  assert.equal(store.inserted.some((i) => i.table === "workforce_movements"), false, "NO_SHOW must NOT create a workforce_movements row");
  assert.equal(store.calls.endAllocations, 1, "Request/Planning allocation must still be ended");
  assert.equal(store.calls.releaseDw, 1);
  assert.equal(store.calls.releaseIt, 1);
  assert.equal(store.calls.excludeMeal, 1);
  const sessionUpdate = store.writes.find((w) => w.table === "employment_sessions");
  assert.equal((sessionUpdate?.patch as Record<string, unknown>)?.status, "ENDED");
  assert.equal((sessionUpdate?.patch as Record<string, unknown>)?.endReason, "NO_SHOW");
});

test("STARTED_THEN_LEFT creates a real resignation movement and reuses finalizeResignationEffect", async () => {
  const store = makeStore({ activeSession: SESSION });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "STARTED_THEN_LEFT",
    eventAt: new Date("2026-09-13T05:00:00Z"),
    reason: "Bỏ về giữa ca",
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  assert.equal(store.calls.finalizeResignation, 1, "STARTED_THEN_LEFT must reuse the canonical resignation effect");
  const movementInsert = store.inserted.find((i) => i.table === "workforce_movements");
  assert.ok(movementInsert, "must create a real workforce_movements row");
  const values = movementInsert!.values as Record<string, unknown>;
  assert.equal(values.movementType, "resignation");
  assert.equal(values.source, "SAME_DAY_REPORT");
  assert.equal(store.calls.releaseDw, 1);
  assert.equal(store.calls.releaseIt, 1);
});

test("double-submit is idempotent — replays the previously computed result, no new writes", async () => {
  const existingEvent = {
    id: "event-old",
    employmentSessionId: "sess-1",
    mealAction: "CANCELLED_BEFORE_CUTOFF",
    dwCodeReleased: true,
    itCodeReleased: true,
  };
  const endedSession = { ...SESSION, status: "ENDED", endDate: TODAY };
  const store = makeStore({ activeSession: null, mostRecentSession: endedSession, existingEvent });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date(),
    reason: null,
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.eventId, "event-old");
  assert.equal(store.calls.releaseDw, 0, "idempotent replay must not release codes again");
  assert.equal(store.calls.endAllocations, 0);
  assert.equal(store.inserted.length, 0);
});

test("NO_ACTIVE_SESSION when the worker never had a session and no prior event exists", async () => {
  const store = makeStore({ activeSession: null, mostRecentSession: null });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-ghost",
    outcome: "NO_SHOW",
    eventAt: new Date(),
    reason: null,
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "NO_ACTIVE_SESSION");
});

test("OUT_OF_SCOPE when the worker's current department is outside the manager's Data Scope", async () => {
  const store = makeStore({ activeSession: SESSION });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "DECLINED_AT_START",
    eventAt: new Date(),
    reason: null,
    session: ACTOR,
    scope: ["some-other-dept"],
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "OUT_OF_SCOPE");
  assert.equal(store.calls.releaseDw, 0, "must not release anything when the scope check fails");
});

test("outcomeLabel returns the expected Vietnamese label for each outcome", async () => {
  const store = makeStore({ activeSession: SESSION });
  const mod = await loadWith(store);
  assert.equal(mod.outcomeLabel("NO_SHOW"), "Không đến nhận việc");
  assert.equal(mod.outcomeLabel("DECLINED_AT_START"), "Đến nhưng không nhận việc");
  assert.equal(mod.outcomeLabel("STARTED_THEN_LEFT"), "Bỏ về trong ca");
});
