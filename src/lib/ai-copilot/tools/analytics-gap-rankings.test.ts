import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../../test-support/load-module.ts";

/**
 * C2 (Mission C — Product Consolidation), independent review fix:
 * get_recruitment_gap_rankings must restrict to LIVE requests
 * (PENDING/PROCESSING) — same strict live/historical separation as C3's
 * management dashboard. Before this fix, a CLOSED request's canonical
 * balance kept padding a department's ranking indefinitely.
 */

const passthrough = (op: string) => (...args: unknown[]) => ({ op, args });

function load(rows: { departmentId: string | null; department: string | null; deptName: string | null; status: string; kpi: { totalRequest: number; totalCurrent: number; totalBalance: number } }[]) {
  return loadModule(new URL("./analytics.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": {
        and: passthrough("and"),
        or: passthrough("or"),
        eq: passthrough("eq"),
        gte: passthrough("gte"),
        lte: passthrough("lte"),
        inArray: passthrough("inArray"),
        isNull: passthrough("isNull"),
        desc: passthrough("desc"),
        sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", text: strings.join("?"), values }), { raw: passthrough("sql.raw") }),
      },
      "@/db": { db: {} },
      "@/db/schema": { employmentSessions: {}, recruitmentRequests: {}, workerProfiles: {}, workforceMovements: {} },
      "@/lib/auth": { getUserScope: async () => null },
      "@/lib/analytics-core": {
        bucketLabel: () => "",
        bucketStart: () => "",
        enumerateBuckets: () => [],
        pctChange: () => 0,
        trendGranularity: () => "day",
      },
      "@/lib/data-scope": { canAggregateTransferIn: () => true, canAggregateTransferOut: () => true },
      "@/lib/helpers": { isFemale: () => false, isMale: () => false, todayStr: () => "2026-10-15" },
      "@/lib/workforce-request": { listWorkforceRequests: async () => rows },
      "../risk-rules.ts": { classifyDepartmentRisk: () => ({ level: "LOW", score: 0, factors: [] }) },
      "../time-resolver.ts": { resolveTimeExpression: () => ({ ok: false, error: "unused" }) },
      "../scope-helpers.ts": {
        capLimit: (requested: unknown, max: number, fallback: number) => {
          const n = typeof requested === "number" ? requested : fallback;
          return Math.max(1, Math.min(max, n));
        },
        intersectDepartmentFilter: () => ({ ok: true, departmentIds: null }),
      },
      "../types.ts": {
        ToolExecutionError: class ToolExecutionError extends Error {
          code: string;
          constructor(code: string, message: string) {
            super(message);
            this.code = code;
          }
        },
      },
    },
  }) as unknown as {
    analyticsTools: {
      name: string;
      execute: (
        ctx: { session: unknown },
        args: Record<string, unknown>,
      ) => Promise<{ data: { rankings: { departmentId: string; gap: number }[] } }>;
    }[];
  };
}

test("get_recruitment_gap_rankings: excludes CLOSED requests (COMPLETED/CANCELLED/EXPIRED) from the gap ranking, keeps only PENDING/PROCESSING", async () => {
  const mod = load([
    { departmentId: "dept-A", department: "Farm A", deptName: "Farm A", status: "PENDING", kpi: { totalRequest: 5, totalCurrent: 2, totalBalance: 3 } },
    // A closed request with a large residual balance — must NOT contribute.
    { departmentId: "dept-A", department: "Farm A", deptName: "Farm A", status: "COMPLETED", kpi: { totalRequest: 100, totalCurrent: 0, totalBalance: 100 } },
    { departmentId: "dept-B", department: "Farm B", deptName: "Farm B", status: "CANCELLED", kpi: { totalRequest: 50, totalCurrent: 0, totalBalance: 50 } },
  ]);

  const tool = mod.analyticsTools.find((t) => t.name === "get_recruitment_gap_rankings")!;
  const res = await tool.execute({ session: { id: "u1", role: "ADMIN" } }, {});

  const deptA = res.data.rankings.find((r) => r.departmentId === "dept-A");
  assert.ok(deptA, "dept-A must appear (has a live request)");
  assert.equal(deptA!.gap, 3, "dept-A's gap must be 3 (live only), never 103 (live + closed)");

  const deptB = res.data.rankings.find((r) => r.departmentId === "dept-B");
  assert.equal(deptB, undefined, "dept-B has ONLY a closed request — must not appear in the live ranking at all");
});
