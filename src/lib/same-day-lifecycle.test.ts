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
 *     Release of operational codes follows the disposition policy (returning-worker fix):
 *       - RETURNING worker → PRESERVE.
 *       - NEW worker + provenance proven → RELEASE.
 *       - Provenance uncertain → PRESERVE (fail-safe).
 *   - STARTED_THEN_LEFT: creates a real resignation workforce_movements row and reuses
 *     the canonical finalizeResignationEffect() — same Quit-counting engine as normal HR
 *     resignation approval. Code release semantics are UNCHANGED.
 *   - idempotent double-submit: second call against an already-ended session with an
 *     existing same_day_lifecycle_events row replays the previous result, no new writes.
 *   - OUT_OF_SCOPE / NO_ACTIVE_SESSION guard rails.
 */

const employmentSessions = makeTable("employment_sessions");
const dailyApplications = makeTable("daily_applications");
const sameDayLifecycleEvents = makeTable("same_day_lifecycle_events");
const workforceMovements = makeTable("workforce_movements");
const dwCodeAssignments = makeTable("dw_code_assignments");
const itCodeAssignments = makeTable("it_code_assignments");
const schemaStub = { employmentSessions, dailyApplications, sameDayLifecycleEvents, workforceMovements, dwCodeAssignments, itCodeAssignments };

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
const APP = { id: "app-1", regDate: "2026-09-13", dwId: "dw-1" };

type StoreOpts = {
  activeSession: typeof SESSION | null;
  mostRecentSession?: typeof SESSION | null;
  existingEvent?: Record<string, unknown> | null;
  /**
   * Prior employment_sessions rows for this worker (other than current session).
   * Non-empty → RETURNING worker. Empty/absent → NEW worker.
   */
  priorSessions?: { id: string }[];
  /**
   * Active DW code assignment for the current session.
   * Present → provenance proven. Absent → provenance unknown.
   */
  activeDwAssignment?: { id: string } | null;
  /**
   * Active IT code assignment for the current session.
   * Present → provenance proven. Absent → provenance unknown.
   */
  activeItAssignment?: { id: string } | null;
};

function makeStore(opts: StoreOpts) {
  const writes: { table: string; patch: unknown }[] = [];
  const inserted: { table: string; values: unknown }[] = [];
  const calls = { finalizeResignation: 0, endAllocations: 0, recompute: 0, releaseDw: 0, releaseIt: 0, excludeMeal: 0, notify: 0, audit: 0 };

  /** Track how many employment_sessions SELECTs with ne(id) we've seen — those are the "prior session" lookups. */
  let esSelectCount = 0;

  const respond = (call: QueryCall): unknown => {
    if (call.table === "employment_sessions") {
      if (call.root === "select") {
        const statusEq = eqValue(call, "employment_sessions.status");
        if (statusEq === "APPROVED") {
          // True ACTIVE-session lookup.
          return opts.activeSession ? [opts.activeSession] : [];
        }
        // Check if this is the "prior sessions" query — it uses ne(id) which
        // appears as a "ne" condition in the fake drizzle. We detect this by
        // looking for an eqValue on workerId paired with lack of status filter.
        const workerEq = eqValue(call, "employment_sessions.workerId");
        if (workerEq && !statusEq) {
          esSelectCount += 1;
          // The SECOND select without status is the prior-session lookup (first
          // is the idempotency fallback which routes through mostRecentSession).
          // Actually, the prior-session query uses ne(id, session.id) AND
          // eq(workerId, ...), no status filter. The "most recent" fallback also
          // has eq(workerId) with no status filter. We differentiate by counting:
          // the prior-session query is the one that runs DURING the active flow,
          // after the session update. When activeSession is set (not idempotent
          // path), the "most recent" code path is never reached. So any
          // employment_sessions SELECT with workerEq and no statusEq in the
          // active flow is the prior-session lookup.
          if (opts.activeSession) {
            // Active flow — this is the prior-session lookup.
            return opts.priorSessions ?? [];
          }
          // Idempotent path — "most recent session" fallback.
          return opts.mostRecentSession ? [opts.mostRecentSession] : opts.activeSession ? [opts.activeSession] : [];
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
    // Code provenance queries.
    if (call.table === "dw_code_assignments" && call.root === "select") {
      return opts.activeDwAssignment ? [opts.activeDwAssignment] : [];
    }
    if (call.table === "it_code_assignments" && call.root === "select") {
      return opts.activeItAssignment ? [opts.activeItAssignment] : [];
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
      "@/lib/operational-code-disposition": await import("./operational-code-disposition.ts"),
      "@/lib/workforce-movements": {
        finalizeResignationEffect: async () => {
          store.calls.finalizeResignation += 1;
          // MISSION F2 section 9 — finalizeResignationEffect() is now the SINGLE canonical
          // code-release injection point: it releases DW/IT codes itself and returns whether it
          // did, so same-day-lifecycle.ts's STARTED_THEN_LEFT branch never calls
          // releaseDwCode()/releaseItCode() a second time (that would silently no-op, since the
          // codes are already released, corrupting the release reason and these result flags).
          return { employmentSessionId: SESSION.id, dwCodeReleased: true, itCodeReleased: true };
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

// ════════════════════════════════════════════════════════════════════════════
// EXISTING TESTS (updated for disposition policy)
// ════════════════════════════════════════════════════════════════════════════

test("NO_SHOW ends the session directly, never touches workforce_movements, never counts as Quit", async () => {
  // NEW worker (no priorSessions) with provenance proven → RELEASE.
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [],
    activeDwAssignment: { id: "dw-assign-1" },
    activeItAssignment: { id: "it-assign-1" },
  });
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
  // MISSION F2 section 9 — STARTED_THEN_LEFT's code release now happens INSIDE
  // finalizeResignationEffect() (stubbed above), so the standalone releaseDwCode()/releaseItCode()
  // must NOT be called a second time here — a double call would be an idempotent no-op against a
  // real db, but would silently overwrite the correct dwCodeReleased/itCodeReleased result with
  // `false` and lose the more specific "STARTED_THEN_LEFT" release reason.
  assert.equal(store.calls.releaseDw, 0, "must not call releaseDwCode directly — finalizeResignationEffect already released it");
  assert.equal(store.calls.releaseIt, 0, "must not call releaseItCode directly — finalizeResignationEffect already released it");
  if (result.ok) {
    assert.equal(result.dwCodeReleased, true, "the result must reflect finalizeResignationEffect's own release outcome");
    assert.equal(result.itCodeReleased, true);
  }
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

/**
 * PRE-MIGRATION INDEPENDENT REVIEW (2026-09-13) — item #3: NO_SHOW/DECLINED_AT_START without an
 * active Employment. Trace: in THIS codebase's actual data model, "arranged to a department" and
 * "Employment Session ACTIVE" are the SAME moment — daily_applications.status flips to APPROVED
 * and employment_sessions.status flips to APPROVED atomically in the SAME transaction (see
 * PATCH /api/registrations/[id] and POST /api/bulk-import — both call autoAllocateInternship()
 * only after the same write that sets status=APPROVED). There is no persisted intermediate
 * "assigned but not yet active" state, and "Bộ phận của tôi" (the only entry point wired to this
 * service) only ever lists workers whose employment session IS already ACTIVE — so a manager can
 * only ever see, and only ever report on, a worker who already has one. A worker whose ONLY
 * session is still PENDING (never approved / never actually arranged to any department) is NOT
 * something a department manager would ever see or need to report on — nobody was ever told to
 * expect them. These tests prove the safe behavior for that residual, off-the-happy-path case:
 * NEVER fabricate an Employment session merely to end it — an honest NO_ACTIVE_SESSION instead.
 */
test("a worker whose ONLY employment session is still PENDING (never approved/arranged) yields NO_ACTIVE_SESSION, never a fabricated Employment", async () => {
  const pendingOnly = { ...SESSION, status: "PENDING" };
  const store = makeStore({ activeSession: null, mostRecentSession: pendingOnly });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date(),
    reason: null,
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "NO_ACTIVE_SESSION");
  assert.equal(store.inserted.length, 0, "must never create a session/event to represent a worker who was never actually arranged");
  assert.equal(store.writes.length, 0, "must never mutate the PENDING session — it was never active to begin with");
});

test("STARTED_THEN_LEFT still requires a real ACTIVE session — same NO_ACTIVE_SESSION guard applies to every outcome, not just NO_SHOW", async () => {
  const store = makeStore({ activeSession: null, mostRecentSession: null });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-ghost",
    outcome: "STARTED_THEN_LEFT",
    eventAt: new Date(),
    reason: null,
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "NO_ACTIVE_SESSION");
  assert.equal(store.calls.finalizeResignation, 0, "must never fabricate a resignation/Quit event for a worker who was never active");
});

// ════════════════════════════════════════════════════════════════════════════
// MANDATORY REGRESSION TESTS — RETURNING WORKER CODE PRESERVATION
// ════════════════════════════════════════════════════════════════════════════

test("1. NEW + NO_SHOW + DW code assigned to current session → DW released", async () => {
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [], // NEW
    activeDwAssignment: { id: "dw-assign-1" },
    activeItAssignment: { id: "it-assign-1" },
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseDw, 1, "DW code must be released for NEW worker with provenance");
  assert.equal(result.dwCodeReleased, true);
});

test("2. NEW + NO_SHOW + IT code assigned to current session → IT released", async () => {
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [], // NEW
    activeDwAssignment: { id: "dw-assign-1" },
    activeItAssignment: { id: "it-assign-1" },
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseIt, 1, "IT code must be released for NEW worker with provenance");
  assert.equal(result.itCodeReleased, true);
});

test("3. NEW + DECLINED_AT_START + current-engagement codes → released", async () => {
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [], // NEW
    activeDwAssignment: { id: "dw-assign-1" },
    activeItAssignment: { id: "it-assign-1" },
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "DECLINED_AT_START",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseDw, 1, "DW code released for NEW + DECLINED_AT_START");
  assert.equal(store.calls.releaseIt, 1, "IT code released for NEW + DECLINED_AT_START");
  assert.equal(result.dwCodeReleased, true);
  assert.equal(result.itCodeReleased, true);
});

test("4. RETURNING + NO_SHOW + existing DW code → preserved", async () => {
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [{ id: "sess-old" }], // RETURNING
    activeDwAssignment: { id: "dw-assign-1" },
    activeItAssignment: { id: "it-assign-1" },
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseDw, 0, "RETURNING worker's DW code must NOT be released on NO_SHOW");
  assert.equal(result.dwCodeReleased, false);
  // Session must still be ended:
  const sessionUpdate = store.writes.find((w) => w.table === "employment_sessions");
  assert.equal((sessionUpdate?.patch as Record<string, unknown>)?.status, "ENDED");
  // Allocations must still be ended:
  assert.equal(store.calls.endAllocations, 1);
  // Meal must still be excluded:
  assert.equal(store.calls.excludeMeal, 1);
});

test("5. RETURNING + NO_SHOW + existing IT code → preserved", async () => {
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [{ id: "sess-old" }], // RETURNING
    activeDwAssignment: { id: "dw-assign-1" },
    activeItAssignment: { id: "it-assign-1" },
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseIt, 0, "RETURNING worker's IT code must NOT be released on NO_SHOW");
  assert.equal(result.itCodeReleased, false);
});

test("6. RETURNING + DECLINED_AT_START → both preserved", async () => {
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [{ id: "sess-old" }], // RETURNING
    activeDwAssignment: { id: "dw-assign-1" },
    activeItAssignment: { id: "it-assign-1" },
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "DECLINED_AT_START",
    eventAt: new Date("2026-09-13T02:30:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseDw, 0, "RETURNING + DECLINED_AT_START must preserve DW code");
  assert.equal(store.calls.releaseIt, 0, "RETURNING + DECLINED_AT_START must preserve IT code");
  assert.equal(result.dwCodeReleased, false);
  assert.equal(result.itCodeReleased, false);
  // Employment session must still be ended correctly:
  assert.equal(store.calls.endAllocations, 1);
  assert.equal(store.calls.excludeMeal, 1);
});

test("7. RETURNING even when current registration is new today → prior Employment history wins; preserve", async () => {
  // Worker registered TODAY for a new position, but has prior employment history.
  // The prior session may be from months ago but its existence makes them RETURNING.
  const store = makeStore({
    activeSession: SESSION, // today's session
    priorSessions: [{ id: "sess-2024-06" }], // old session from months ago
    activeDwAssignment: { id: "dw-assign-1" }, // provenance proven for THIS session
    activeItAssignment: { id: "it-assign-1" }, // provenance proven for THIS session
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Even though provenance is proven AND the registration is brand new today,
  // the existence of prior Employment history means RETURNING → PRESERVE.
  assert.equal(store.calls.releaseDw, 0, "prior employment history wins — must preserve");
  assert.equal(store.calls.releaseIt, 0, "prior employment history wins — must preserve");
  assert.equal(result.dwCodeReleased, false);
  assert.equal(result.itCodeReleased, false);
});

test("8. Legacy mirror exists but no trustworthy assignment provenance → preserve", async () => {
  // NEW worker — no prior sessions. But code assignments don't belong to current
  // session (legacy mirror only, no it_code_assignments/dw_code_assignments row
  // for this session). Fail-safe: PRESERVE.
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [], // NEW worker
    activeDwAssignment: null, // no provenance — legacy mirror only
    activeItAssignment: null, // no provenance — legacy mirror only
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseDw, 0, "no trustworthy provenance — must preserve (fail-safe)");
  assert.equal(store.calls.releaseIt, 0, "no trustworthy provenance — must preserve (fail-safe)");
  assert.equal(result.dwCodeReleased, false);
  assert.equal(result.itCodeReleased, false);
});

test("9. STARTED_THEN_LEFT → existing release/resignation behavior unchanged (disposition not applied)", async () => {
  // STARTED_THEN_LEFT must NOT consult the disposition policy.
  // Even for a RETURNING worker, STARTED_THEN_LEFT uses finalizeResignationEffect().
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [{ id: "sess-old" }], // RETURNING — but irrelevant for STARTED_THEN_LEFT
  });
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
  if (!result.ok) return;
  assert.equal(store.calls.finalizeResignation, 1, "must use canonical resignation effect");
  assert.equal(result.dwCodeReleased, true, "finalizeResignationEffect releases codes");
  assert.equal(result.itCodeReleased, true);
  // Must NOT call standalone release functions:
  assert.equal(store.calls.releaseDw, 0);
  assert.equal(store.calls.releaseIt, 0);
});

test("10. Double submit remains idempotent (with disposition)", async () => {
  const existingEvent = {
    id: "event-old",
    employmentSessionId: "sess-1",
    mealAction: "CANCELLED_BEFORE_CUTOFF",
    dwCodeReleased: false, // was preserved in first call
    itCodeReleased: false,
  };
  const endedSession = { ...SESSION, status: "ENDED", endDate: TODAY };
  const store = makeStore({ activeSession: null, mostRecentSession: endedSession, existingEvent });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date(),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.eventId, "event-old");
  assert.equal(result.dwCodeReleased, false, "replayed result reflects original preserve decision");
  assert.equal(result.itCodeReleased, false);
  assert.equal(store.calls.releaseDw, 0, "idempotent replay must not release codes");
  assert.equal(store.calls.releaseIt, 0);
  assert.equal(store.calls.endAllocations, 0, "idempotent replay must not re-end allocations");
  assert.equal(store.inserted.length, 0, "idempotent replay must not insert new rows");
});

test("11. Preserving codes must not leave Request/Planning/meal state incorrectly active", async () => {
  // RETURNING + NO_SHOW → codes preserved, but all other state MUST still be ended/excluded.
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [{ id: "sess-old" }], // RETURNING → preserve codes
    activeDwAssignment: { id: "dw-assign-1" },
    activeItAssignment: { id: "it-assign-1" },
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Codes preserved:
  assert.equal(store.calls.releaseDw, 0);
  assert.equal(store.calls.releaseIt, 0);

  // But everything else must still happen:
  // 1. Employment session ended:
  const sessionUpdate = store.writes.find((w) => w.table === "employment_sessions");
  assert.ok(sessionUpdate, "employment session must still be ended");
  assert.equal((sessionUpdate?.patch as Record<string, unknown>)?.status, "ENDED");

  // 2. Request allocations ended:
  assert.equal(store.calls.endAllocations, 1, "request/planning allocations must still be ended");

  // 3. Recruitment KPI recomputed:
  assert.equal(store.calls.recompute, 1, "recruitment KPI must still be recomputed");

  // 4. Meal excluded:
  assert.equal(store.calls.excludeMeal, 1, "meal exclusion must still happen");

  // 5. Event recorded:
  const eventInsert = store.inserted.find((i) => i.table === "same_day_lifecycle_events");
  assert.ok(eventInsert, "same_day_lifecycle_events row must still be created");
  const eventValues = eventInsert?.values as Record<string, unknown>;
  assert.equal(eventValues.dwCodeReleased, false, "event must record that codes were preserved");
  assert.equal(eventValues.itCodeReleased, false);

  // 6. Audit + notification:
  assert.equal(store.calls.audit, 1, "audit must still be written");
  assert.equal(store.calls.notify, 1, "notification must still be queued");
});

// ════════════════════════════════════════════════════════════════════════════
// MANDATORY PER-CODE DISCRIMINATION TESTS (PR #217 review fix)
// ════════════════════════════════════════════════════════════════════════════

test("12. NEW + DW provenance true + IT provenance false → DW released, IT preserved", async () => {
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [], // NEW worker
    activeDwAssignment: { id: "dw-assign-1" }, // DW provenance proven
    activeItAssignment: null, // IT provenance uncertain
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseDw, 1, "DW code must be released when DW provenance is proven");
  assert.equal(store.calls.releaseIt, 0, "IT code must NOT be released when IT provenance is uncertain");
  assert.equal(result.dwCodeReleased, true);
  assert.equal(result.itCodeReleased, false);
});

test("13. NEW + DW provenance false + IT provenance true → DW preserved, IT released", async () => {
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [], // NEW worker
    activeDwAssignment: null, // DW provenance uncertain
    activeItAssignment: { id: "it-assign-1" }, // IT provenance proven
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "NO_SHOW",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseDw, 0, "DW code must NOT be released when DW provenance is uncertain");
  assert.equal(store.calls.releaseIt, 1, "IT code must be released when IT provenance is proven");
  assert.equal(result.dwCodeReleased, false);
  assert.equal(result.itCodeReleased, true);
});

test("14. RETURNING + both provenance true → neither released (RETURNING master guard)", async () => {
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [{ id: "sess-old" }], // RETURNING
    activeDwAssignment: { id: "dw-assign-1" }, // provenance proven — but irrelevant
    activeItAssignment: { id: "it-assign-1" }, // provenance proven — but irrelevant
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "DECLINED_AT_START",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseDw, 0, "RETURNING master guard must prevent DW release even with proven provenance");
  assert.equal(store.calls.releaseIt, 0, "RETURNING master guard must prevent IT release even with proven provenance");
  assert.equal(result.dwCodeReleased, false);
  assert.equal(result.itCodeReleased, false);
});

test("15. NEW + uncertain legacy provenance for both → corresponding codes preserved", async () => {
  // Same as test 8 but re-stated explicitly for the per-code discrimination matrix.
  const store = makeStore({
    activeSession: SESSION,
    priorSessions: [], // NEW worker
    activeDwAssignment: null, // no DW provenance
    activeItAssignment: null, // no IT provenance
  });
  const mod = await loadWith(store);

  const result = await mod.applySameDayLifecycleEvent({
    workerId: "worker-1",
    outcome: "DECLINED_AT_START",
    eventAt: new Date("2026-09-13T02:00:00Z"),
    session: ACTOR,
    scope: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.calls.releaseDw, 0, "uncertain DW provenance → DW preserved");
  assert.equal(store.calls.releaseIt, 0, "uncertain IT provenance → IT preserved");
  assert.equal(result.dwCodeReleased, false);
  assert.equal(result.itCodeReleased, false);
});

