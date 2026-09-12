/**
 * C2 (Mission C — Product Consolidation) RECONCILIATION TEST.
 * ------------------------------------------------------------
 * Proves that the UNFILLED/FILLED list filter, the default list sort, and
 * getRecruitmentStats() (which feeds the AI Copilot get_recruitment_stats
 * tool) all agree with the CANONICAL, allocation-aware engine
 * (batchComputeRequestKpis/computeRequestKpi) rather than the stale,
 * persisted recruitmentRequests.totalBalance/maleBalance/femaleBalance
 * columns — and that this test FAILS if that canonicalization is reverted
 * (see the "OLD BEHAVIOR" control tests below, which pin the exact old,
 * wrong SQL-only aggregation so a revert is caught immediately).
 *
 * Exact numeric example from the Mission C spec:
 *   RQ09: target=10, current=10 -> canonical balance = 0
 *         persisted (stale) balance intentionally WRONG = 4
 *   RQ10: target=5,  current=3  -> canonical balance = 2
 *         persisted (stale) balance intentionally WRONG = 0
 *
 * With the stale column, RQ09 (fully staffed) would still show as
 * "UNFILLED" (balance=4>0) and RQ10 (still short 2) would show as "FILLED"
 * (balance=0) — the exact inversion this mission eliminates. Old-style
 * aggregate SUM(totalBalance) = 4, new canonical SUM(kpi.totalBalance) = 2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, makeTable, type FakeDb } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

const schemaStub = {
  departments: makeTable("departments"),
  recruitmentRequests: makeTable("recruitment_requests"),
  planningPeriods: makeTable("planning_periods"),
  planningTargets: makeTable("planning_targets"),
  planningAllocations: makeTable("planning_allocations"),
  employmentSessions: makeTable("employment_sessions"),
  requestAllocations: makeTable("request_allocations"),
  requestAllocationHistory: makeTable("request_allocation_history"),
  workerProfiles: makeTable("worker_profiles"),
  workforceMovements: makeTable("workforce_movements"),
  dailyApplications: makeTable("daily_applications"),
};

const helpersStub = {
  todayStr: () => "2026-08-16",
  isMale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("M") || g === "Nam",
  isFemale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("F") || g === "Nữ",
  toVNDateStr: (d: Date) => d.toISOString().slice(0, 10),
};

/**
 * RQ09/RQ10 exact example from the mission spec. `totalBalance` here is the
 * STALE, intentionally-wrong PERSISTED column value (never read by the fix);
 * `canonicalBalance` is what batchComputeRequestKpis() (faked below, mirroring
 * the real formula max(0, target - current)) returns for the same row.
 */
const RQ09 = { id: "rq09", requestCode: "RQ09", expectedDate: "2026-08-01", status: "PENDING", createdAt: new Date("2026-01-01"), totalRequest: 10, target: 10, current: 10, totalBalance: 4 };
const RQ10 = { id: "rq10", requestCode: "RQ10", expectedDate: "2026-08-02", status: "PENDING", createdAt: new Date("2026-01-02"), totalRequest: 5, target: 5, current: 3, totalBalance: 0 };
const ROWS = [RQ09, RQ10];

function canonicalBalanceOf(row: { target: number; current: number }): number {
  return Math.max(0, row.target - row.current);
}

function load(db: FakeDb) {
  const utils = loadModule(new URL("./recruitment-request-utils.ts", import.meta.url), { stubs: {} });
  const columns = loadModule(new URL("./recruitment-request-columns.ts", import.meta.url), { stubs: {} });
  const core = loadModule(new URL("./planning-recruitment-core.ts", import.meta.url), {
    stubs: { "./recruitment-request-columns.ts": columns },
  });
  const workforceRequestKpi = loadModule(new URL("./workforce-request-kpi.ts", import.meta.url), { stubs: {} });
  const recruitmentKpi = loadModule(new URL("./recruitment-kpi.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStubFor(db),
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": helpersStub,
      "@/lib/workforce-request-kpi": workforceRequestKpi,
    },
  });
  const provisioning = loadModule(new URL("./recruitment-request-provisioning.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStubFor(db),
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": helpersStub,
      "@/lib/workforce-request-kpi": workforceRequestKpi,
      "@/lib/recruitment-kpi": recruitmentKpi,
    },
  });
  return loadModule(new URL("./recruitment-request.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStubFor(db),
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": helpersStub,
      "@/lib/planning-recruitment-core": core,
      "@/lib/recruitment-request-utils": utils,
      "@/lib/recruitment-request-columns": columns,
      "@/lib/recruitment-request-provisioning": provisioning,
      "@/lib/workforce-request": {
        RECRUITED_STAGE: "APPROVED",
        // Mirrors the REAL canonical formula (max(0, target - current)) — this
        // is the "canonical engine" side of the reconciliation, kept a pure,
        // trivially-auditable fake so this test isolates listRecruitmentRequests'/
        // getRecruitmentStats' WIRING to it, not the formula's own correctness
        // (covered separately by workforce-request-kpi.test.ts).
        batchComputeRequestKpis: async (rows: { id: string }[]) => {
          const map = new Map<string, { totalBalance: number; maleBalance: number; femaleBalance: number; maleRecruited: number; femaleRecruited: number }>();
          for (const r of rows) {
            const fixture = ROWS.find((x) => x.id === r.id)!;
            map.set(r.id, { totalBalance: canonicalBalanceOf(fixture), maleBalance: 0, femaleBalance: 0, maleRecruited: 0, femaleRecruited: 0 });
          }
          return map;
        },
      },
      "@/lib/workforce-request-kpi": workforceRequestKpi,
      "@/lib/data-scope": { scopeAllowsDepartment: () => true },
      "drizzle-orm/pg-core": {},
    },
    fallback(spec) {
      if (spec.includes("recruitment-request-utils")) return utils;
      throw new Error(`Unexpected require("${spec}")`);
    },
  });
}

// Minimal drizzle stub matching what the loaded modules need for this test's
// query shapes — mirrors src/lib/test-support/fake-drizzle.ts's own drizzleStub.
function drizzleStubFor(_db: FakeDb) {
  const passthrough = (op: string) => (...args: unknown[]) => ({ op, args });
  return {
    and: passthrough("and"),
    or: passthrough("or"),
    eq: passthrough("eq"),
    ne: passthrough("ne"),
    gte: passthrough("gte"),
    lte: passthrough("lte"),
    like: passthrough("like"),
    isNull: passthrough("isNull"),
    isNotNull: passthrough("isNotNull"),
    inArray: passthrough("inArray"),
    desc: passthrough("desc"),
    asc: passthrough("asc"),
    count: passthrough("count"),
    sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", text: strings.join("?"), values }), {
      raw: passthrough("sql.raw"),
    }),
  };
}

test("C2 RECONCILIATION — RQ09 (target10/current10, stale=4) + RQ10 (target5/current3, stale=0): canonical balance is 0 and 2, exactly reversed from the stale column", () => {
  assert.equal(canonicalBalanceOf(RQ09), 0, "RQ09 is fully staffed — canonical balance must be 0, not the stale 4");
  assert.equal(canonicalBalanceOf(RQ10), 2, "RQ10 is still short 2 — canonical balance must be 2, not the stale 0");
});

test("C2 RECONCILIATION — listRecruitmentRequests(UNFILLED) returns RQ10, NOT RQ09 (canonical), inverted from what the stale column would return", async () => {
  const db = createFakeDb({ respond: () => ROWS });
  const mod = load(db);

  const res = (await (mod.listRecruitmentRequests as (f: unknown) => Promise<{ rows: { requestCode: string }[] }>)({
    fulfillment: "UNFILLED",
  })) as { rows: { requestCode: string }[] };

  assert.equal(res.rows.map((r) => r.requestCode).join(","), "RQ10", "UNFILLED must be RQ10 (canonical balance 2 > 0), not RQ09");

  // OLD BEHAVIOR CONTROL — proves this test would have FAILED before the C2
  // fix: filtering by the STALE totalBalance column instead gives the exact
  // wrong answer (RQ09, not RQ10).
  const staleUnfilled = ROWS.filter((r) => r.totalBalance > 0).map((r) => r.requestCode);
  assert.equal(staleUnfilled.join(","), "RQ09", "sanity: the stale column's own UNFILLED set is RQ09 — the wrong, inverted answer this fix corrects");
});

test("C2 RECONCILIATION — listRecruitmentRequests(FILLED) returns RQ09, NOT RQ10 (canonical)", async () => {
  const db = createFakeDb({ respond: () => ROWS });
  const mod = load(db);

  const res = (await (mod.listRecruitmentRequests as (f: unknown) => Promise<{ rows: { requestCode: string }[] }>)({
    fulfillment: "FILLED",
  })) as { rows: { requestCode: string }[] };

  assert.equal(res.rows.map((r) => r.requestCode).join(","), "RQ09", "FILLED must be RQ09 (canonical balance 0), not RQ10");
});

test("C2 RECONCILIATION — getRecruitmentStats().totalBalance sums the CANONICAL balance (2), not the stale column sum (4)", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "recruitment_requests" && call.ops.some((o) => o.fn === "groupBy")) {
        return [{ status: "PENDING", count: 2 }];
      }
      return ROWS;
    },
  });
  const mod = load(db);

  const stats = (await (mod.getRecruitmentStats as (s?: string[] | null) => Promise<{ totalBalance: number }>)()) as { totalBalance: number };
  assert.equal(stats.totalBalance, 2, "canonical: RQ09(0) + RQ10(2) = 2");

  // OLD BEHAVIOR CONTROL — the stale column's own sum is 4 (RQ09's wrong 4 +
  // RQ10's wrong 0), the exact wrong number get_recruitment_stats (feeding
  // the AI Copilot tool) used to report before this fix.
  const staleSum = ROWS.reduce((acc, r) => acc + r.totalBalance, 0);
  assert.equal(staleSum, 4, "sanity: the stale column's own sum is 4 — the wrong number this fix corrects");
  assert.notEqual(stats.totalBalance, staleSum, "canonical and stale sums must genuinely disagree for this fixture (proves the test isn't vacuous)");
});

test("C2 RECONCILIATION — getRecruitmentStats().totalMaleRq/totalFemaleRq come from an EXACT SQL SUM, not the bounded MAX_KPI_CANDIDATES fetch (independent review fix)", async () => {
  // A distinct fixture proves the exact-sum query is genuinely a SEPARATE
  // code path from the bounded candidates fetch, not accidentally reading
  // the same array: exactSums returns a SINGLE aggregate row unrelated to
  // ROWS' own maleRq/femaleRq, and candidates still returns ROWS unchanged
  // (so Recruited/Balance — which DO require canonical KPI — are unaffected).
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "recruitment_requests" && call.ops.some((o) => o.fn === "groupBy")) {
        return [{ status: "PENDING", count: 2 }];
      }
      // The exact-sum query has neither groupBy NOR orderBy/limit — the
      // candidates query (bounded, MAX_KPI_CANDIDATES) has orderBy+limit.
      if (call.root === "select" && call.table === "recruitment_requests" && !call.ops.some((o) => o.fn === "orderBy" || o.fn === "limit")) {
        return [{ maleRq: 999, femaleRq: 111 }];
      }
      return ROWS;
    },
  });
  const mod = load(db);

  const stats = (await (mod.getRecruitmentStats as (s?: string[] | null) => Promise<{ totalMaleRq: number; totalFemaleRq: number; totalBalance: number }>)()) as {
    totalMaleRq: number;
    totalFemaleRq: number;
    totalBalance: number;
  };

  assert.equal(stats.totalMaleRq, 999, "totalMaleRq must come from the exact SUM query result, not summed from the bounded candidates array");
  assert.equal(stats.totalFemaleRq, 111, "totalFemaleRq must come from the exact SUM query result, not summed from the bounded candidates array");
  // Recruited/Balance still come from the canonical engine over `candidates` (ROWS) — unaffected by the exact-sum split.
  assert.equal(stats.totalBalance, 2, "canonical Balance sum must still be RQ09(0) + RQ10(2) = 2, unaffected by the exact-sum fix");
});
