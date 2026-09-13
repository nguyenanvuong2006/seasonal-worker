import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, type FakeDb } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/**
 * PRE-MIGRATION INDEPENDENT REVIEW (2026-09-13) — item #2: Daily Arrangement EDITABLE Request.
 * Runs the REAL src/lib/planning.ts#autoAllocateInternship() with its new optional
 * `preferredRequestId` parameter, proving:
 *   - with no override, the deterministic default (first eligible candidate) is used, same as
 *     before this review (no regression to the existing auto-recommend behavior);
 *   - an explicit, ELIGIBLE alternate choice is honored — the chosen request receives the
 *     allocation, not the default recommendation;
 *   - a stale/unknown/out-of-scope requestId is REJECTED explicitly (REQUEST_NOT_ELIGIBLE),
 *     never silently falling back to the default recommendation;
 *   - capacity enforcement (mirrorPlanningAllocationToRequest / REJECTED_FULL) still applies
 *     when a preferred request is chosen — the override never bypasses the canonical planner.
 */

const schemaStub = {
  departments: makeTable("departments"),
  employmentSessions: makeTable("employment_sessions"),
  planningAllocations: makeTable("planning_allocations"),
  planningPeriods: makeTable("planning_periods"),
  planningTargets: makeTable("planning_targets"),
  recruitmentRequests: makeTable("recruitment_requests"),
  workerProfiles: makeTable("worker_profiles"),
  workforceMovements: makeTable("workforce_movements"),
};

type MirrorOutcome = { status: "SYNCED"; requestId: string } | { status: "REJECTED_FULL"; requestId: string } | { status: "NOT_LINKED" };

function load(db: FakeDb, opts: { mirrorOutcome?: MirrorOutcome; mirrorCalls?: unknown[] } = {}) {
  return loadModule(new URL("./planning.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": {
        todayStr: () => "2026-08-16",
        isMale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("N"),
        isFemale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("F"),
      },
      "@/lib/person-name": { normalizePersonName: (v: string) => v },
      "@/lib/workforce-request": {
        mirrorPlanningAllocationToRequest: async (...args: unknown[]) => {
          opts.mirrorCalls?.push(args);
          return opts.mirrorOutcome ?? { status: "NOT_LINKED" };
        },
      },
    },
    fallback(spec) {
      throw new Error(`Unexpected require("${spec}")`);
    },
  });
}

/** Two ACTIVE periods for the same department, each linked to a DIFFERENT Recruitment Request. */
function twoLinkedPeriodsDb() {
  let n = 0;
  return createFakeDb({
    respond(call) {
      if (call.root !== "select") return undefined;
      n += 1;
      if (n === 1) {
        return [
          { id: "period-A", requestId: "rq-A", startDate: "2026-01-01", endDate: "2026-12-31", requestType: "ORIGINAL", supplementIndex: 0, demandMale: 10, demandFemale: 10, targetCount: 20 },
          { id: "period-B", requestId: "rq-B", startDate: "2026-01-01", endDate: "2026-12-31", requestType: "SUPPLEMENT", supplementIndex: 1, demandMale: 10, demandFemale: 10, targetCount: 20 },
        ];
      }
      if (n === 2) return [{ workerId: "worker-1", gender: "Nam" }];
      if (n === 3) return []; // no existing allocations counted against either candidate period
      return []; // no existing allocation for THIS session
    },
  });
}

type AutoAllocateOutcome = { planningAllocated: boolean; planningPeriodId: string | null; requestSync: { status: string; requestId?: string } };
type AutoAllocateFn = (a: string, b: string, c?: string | null, d?: string, e?: unknown, f?: string | null) => Promise<AutoAllocateOutcome>;

test("no override: deterministic default picks the FIRST eligible candidate (rq-A), same as before this review", async () => {
  const db = twoLinkedPeriodsDb();
  const mirrorCalls: unknown[] = [];
  const mod = load(db, { mirrorOutcome: { status: "SYNCED", requestId: "rq-A" }, mirrorCalls });

  const chosen = await (mod.autoAllocateInternship as AutoAllocateFn)("sess-1", "dept-A", "2026-06-01", "recruiter1", db);

  assert.equal(chosen.planningAllocated, true);
  assert.equal(chosen.planningPeriodId, "period-A");
  assert.equal(chosen.requestSync.status, "SYNCED");
  assert.equal(chosen.requestSync.requestId, "rq-A");
});

test("explicit alternate choice (rq-B) is honored — the CHOSEN request receives the allocation, not the default", async () => {
  const db = twoLinkedPeriodsDb();
  const mirrorCalls: unknown[] = [];
  const mod = load(db, { mirrorOutcome: { status: "SYNCED", requestId: "rq-B" }, mirrorCalls });

  const chosen = await (mod.autoAllocateInternship as AutoAllocateFn)("sess-1", "dept-A", "2026-06-01", "recruiter1", db, "rq-B");

  assert.equal(chosen.planningAllocated, true);
  assert.equal(chosen.planningPeriodId, "period-B", "must use the period LINKED to the chosen request, not the default recommendation");
  assert.equal(chosen.requestSync.status, "SYNCED");
  assert.equal(chosen.requestSync.requestId, "rq-B");
  assert.equal(mirrorCalls.length, 1);
});

test("a stale/unknown requestId is REJECTED explicitly — never silently falls back to the default recommendation", async () => {
  const db = twoLinkedPeriodsDb();
  const mirrorCalls: unknown[] = [];
  const mod = load(db, { mirrorCalls });

  const chosen = await (mod.autoAllocateInternship as AutoAllocateFn)("sess-1", "dept-A", "2026-06-01", "recruiter1", db, "rq-does-not-exist");

  assert.equal(chosen.planningAllocated, false);
  assert.equal(chosen.requestSync.status, "REQUEST_NOT_ELIGIBLE");
  assert.equal(db.writesTo("planning_allocations").length, 0, "must not allocate anything when the chosen request is not a valid candidate for this department");
  assert.equal(mirrorCalls.length, 0, "must never reach the Request mirror step for a rejected choice");
});

test("capacity enforcement still applies to an explicitly chosen request — the override never bypasses REJECTED_FULL", async () => {
  const db = twoLinkedPeriodsDb();
  const mod = load(db, { mirrorOutcome: { status: "REJECTED_FULL", requestId: "rq-B" } });

  const chosen = await (mod.autoAllocateInternship as AutoAllocateFn)("sess-1", "dept-A", "2026-06-01", "recruiter1", db, "rq-B");

  assert.equal(chosen.planningAllocated, true, "Planning allocation still succeeds (canonical rule: never rollback Employment/Planning for Request capacity)");
  assert.equal(chosen.requestSync.status, "REJECTED_FULL", "but the Request attribution itself is explicitly rejected by the canonical capacity check");
});

test("an out-of-department requestId (not among this department's ACTIVE periods) is rejected the same way", async () => {
  const db = twoLinkedPeriodsDb();
  const mod = load(db, {});

  // "rq-elsewhere" is a syntactically valid id but not linked to ANY active period of dept-A.
  const chosen = await (mod.autoAllocateInternship as AutoAllocateFn)("sess-1", "dept-A", "2026-06-01", "recruiter1", db, "rq-elsewhere");

  assert.equal(chosen.planningAllocated, false);
  assert.equal(chosen.requestSync.status, "REQUEST_NOT_ELIGIBLE");
});
