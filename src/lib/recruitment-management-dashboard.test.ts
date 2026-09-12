/**
 * C3 (Mission C — Product Consolidation) — getRecruitmentManagementDashboard().
 * ------------------------------------------------------------
 * Runs on the REAL src/lib/workforce-request.ts (hermetic module loader, same
 * convention as workforce-request-db.test.ts). Proves:
 *   - Current DWS comes from the Employment roster (getDepartmentWorkforceRoster),
 *     independent of request allocation.
 *   - A CLOSED request (COMPLETED/CANCELLED/EXPIRED) never contributes to
 *     demand/attributed/gap/recruited/quit/transferOut — the strict live/
 *     historical separation double-counting safeguard.
 *   - Department-level rows sum correctly and are keyed by departmentId.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, type FakeDb, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";
import { toVNDateStr } from "./helpers.ts";

const TODAY = "2026-10-15";

const requestAllocations = makeTable("request_allocations");
const employmentSessions = makeTable("employment_sessions");
const workerProfiles = makeTable("worker_profiles");
const workforceMovements = makeTable("workforce_movements");
const dailyApplications = makeTable("daily_applications");
const recruitmentRequests = makeTable("recruitment_requests");
const departments = makeTable("departments");
const planningPeriods = makeTable("planning_periods");
const schemaStub = {
  requestAllocations,
  employmentSessions,
  workerProfiles,
  workforceMovements,
  dailyApplications,
  recruitmentRequests,
  departments,
  planningPeriods,
};

type RequestRow = {
  id: string;
  requestCode: string;
  department: string | null;
  departmentId: string | null;
  status: string;
  maleRq: number;
  femaleRq: number;
  totalRequest: number;
  expectedDate: string | null;
  requestedDate: string | null;
  endDate: string | null;
  createdAt: Date;
};

// RQ-LIVE: open (PENDING), target 5, no current attribution -> gap 5.
const RQ_LIVE: RequestRow = {
  id: "rq-live",
  requestCode: "RQ-LIVE",
  department: "Farm A",
  departmentId: "dept-A",
  status: "PENDING",
  maleRq: 3,
  femaleRq: 2,
  totalRequest: 5,
  expectedDate: "2026-11-01",
  requestedDate: "2026-09-01",
  endDate: null,
  createdAt: new Date("2026-09-01"),
};

// RQ-CLOSED: COMPLETED with a large target — must NEVER be summed into live totals.
const RQ_CLOSED: RequestRow = {
  id: "rq-closed",
  requestCode: "RQ-CLOSED",
  department: "Farm A",
  departmentId: "dept-A",
  status: "COMPLETED",
  maleRq: 50,
  femaleRq: 50,
  totalRequest: 100,
  expectedDate: "2026-08-01",
  requestedDate: "2026-07-01",
  endDate: "2026-08-15",
  createdAt: new Date("2026-07-01"),
};

function load(db: FakeDb) {
  const kpi = loadModule(new URL("./workforce-request-kpi.ts", import.meta.url), { stubs: {} });
  return loadModule(new URL("./workforce-request.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/auth": { getUserScope: async () => null, hasPermission: async () => false, writeAudit: async () => undefined },
      "@/lib/data-scope": { scopeAllowsDepartment: () => true },
      "@/lib/helpers": {
        todayStr: () => TODAY,
        isMale: (g: string | null) => g === "Nam",
        isFemale: (g: string | null) => g === "Nữ",
        toVNDateStr,
      },
      "@/lib/person-name": { normalizePersonName: (s: string) => s },
      "@/lib/workforce-request-kpi": kpi,
      "@/lib/workforce-roster": {
        getDepartmentWorkforceRoster: async (scope: string[] | null) => {
          if (scope !== null && scope.length === 0) return [];
          return [
            { workerId: "w1", deptId: "dept-A", deptName: "Farm A", gender: "Nam" },
            { workerId: "w2", deptId: "dept-A", deptName: "Farm A", gender: "Nữ" },
            { workerId: "w3", deptId: "dept-B", deptName: "Farm B", gender: "Nam" },
          ];
        },
      },
    },
  });
}

function respond(call: QueryCall): unknown {
  // listWorkforceRequests()'s main query shape: select({ request: recruitmentRequests,
  // deptName: departments.deptName }).from(recruitmentRequests).leftJoin(departments, ...).
  if (call.table === "recruitment_requests" && call.root === "select") {
    return [
      { request: RQ_LIVE, deptName: RQ_LIVE.department },
      { request: RQ_CLOSED, deptName: RQ_CLOSED.department },
    ];
  }
  // No allocations/quits/transfers/pipeline/planning-periods fixtured — every
  // request's canonical current/recruited/quit/transferOut is 0, so
  // RQ_LIVE's gap = target (5) and RQ_CLOSED's would-be gap = target (100) —
  // proving RQ_CLOSED's 100 never leaks into the dashboard's live totals.
  return [];
}

test("getRecruitmentManagementDashboard: CLOSED request (COMPLETED) never contributes to live demand/gap — only RQ-LIVE's 5, never RQ-CLOSED's 100", async () => {
  const db = createFakeDb({ respond });
  const mod = load(db);

  const dashboard = await (mod.getRecruitmentManagementDashboard as (
    scope: string[] | null,
    asOf?: string,
  ) => Promise<{
    currentDwsAsOfDate: string;
    summary: { demand: { total: number }; gap: { total: number } };
    departments: { departmentId: string; demand: { total: number }; gap: { total: number }; currentDws: { total: number }; liveRequestCount: number }[];
    liveRequests: { requestCode: string }[];
  }>)(null, "2026-08-01");

  // Independent review fix: currentDwsAsOfDate is ALWAYS today (todayStr()),
  // never the `asOf` passed in — currentDws itself has no historical snapshot.
  assert.equal(dashboard.currentDwsAsOfDate, TODAY, "currentDwsAsOfDate must be today, independent of the asOf argument passed in");

  // Summary must equal RQ-LIVE alone (5), never RQ-LIVE + RQ-CLOSED (105).
  assert.equal(dashboard.summary.demand.total, 5, "closed request's target (100) must not leak into live demand");
  assert.equal(dashboard.summary.gap.total, 5, "closed request's balance must not leak into live gap");

  // liveRequests drill-down must list ONLY the open request.
  assert.deepEqual(dashboard.liveRequests.map((r) => r.requestCode), ["RQ-LIVE"]);

  // Department dept-A: Current DWS = 2 (w1+w2, from Employment roster,
  // independent of request status), demand/gap = 5 (RQ-LIVE only), 1 live request.
  const deptA = dashboard.departments.find((d) => d.departmentId === "dept-A")!;
  assert.ok(deptA, "dept-A must be present");
  assert.equal(deptA.currentDws.total, 2, "Current DWS from Employment roster, independent of request status");
  assert.equal(deptA.demand.total, 5);
  assert.equal(deptA.gap.total, 5);
  assert.equal(deptA.liveRequestCount, 1);

  // Department dept-B: has Employment roster presence (w3) but NO recruitment
  // request at all — must still appear (Current DWS visible even with zero demand).
  const deptB = dashboard.departments.find((d) => d.departmentId === "dept-B")!;
  assert.ok(deptB, "dept-B must be present even with no recruitment requests");
  assert.equal(deptB.currentDws.total, 1);
  assert.equal(deptB.demand.total, 0);
  assert.equal(deptB.liveRequestCount, 0);
});

test("getRecruitmentManagementDashboard: scope=[] (no department granted) -> empty roster AND empty request list, no crash", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);
  const dashboard = await (mod.getRecruitmentManagementDashboard as (
    scope: string[] | null,
  ) => Promise<{ summary: { currentDws: { total: number }; demand: { total: number } }; departments: unknown[] }>)([]);

  assert.equal(dashboard.summary.currentDws.total, 0);
  assert.equal(dashboard.summary.demand.total, 0);
  assert.equal(dashboard.departments.length, 0);
});
