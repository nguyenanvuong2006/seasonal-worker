import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../../test-support/load-module.ts";

/* ============================================================
   final-project-hardening — regression: get_recruitment_requests() phải
   dùng KPI CANONICAL (batchComputeRequestKpis, cùng engine với
   /api/recruitment-requests GET) cho maleBalance/femaleBalance/totalBalance,
   KHÔNG dùng thẳng cột persisted stale trên hàng trả về từ
   listRecruitmentRequests() — cột đó KHÔNG phải nguồn UI chính dùng nữa từ
   Phase 2B, nên AI Copilot trả lời "còn thiếu bao nhiêu" không được phép
   dùng số khác với UI.
   ============================================================ */

function load(opts: {
  rows: { id: string; requestCode: string; departmentId: string | null; department: string | null; position: string | null; status: string; requestedDate: string | null; expectedDate: string | null; maleRq: number; femaleRq: number; maleBalance: number; femaleBalance: number; totalBalance: number }[];
  canonicalKpiByRequestId: Map<string, { maleBalance: number; femaleBalance: number; totalBalance: number }>;
}) {
  const batchComputeRequestKpisCalls: unknown[] = [];
  return loadModule(new URL("./recruitment.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "@/lib/auth": { getUserScope: async () => null },
      "@/lib/helpers": { todayStr: () => "2026-10-15" },
      "@/lib/recruitment-kpi": { computeRecruitmentKpis: async () => ({}) },
      "@/lib/recruitment-request": {
        listRecruitmentRequests: async () => ({ rows: opts.rows, total: opts.rows.length }),
        getRecruitmentStats: async () => ({}),
        getRecruitmentRequest: async () => null,
      },
      "@/lib/workforce-request": {
        batchComputeRequestKpis: async (rows: { id: string }[]) => {
          batchComputeRequestKpisCalls.push(rows);
          return opts.canonicalKpiByRequestId;
        },
      },
      "@/lib/workforce-request-kpi": { resolveDefaultAsOf: () => "2026-10-15" },
      "../types.ts": {
        ToolExecutionError: class ToolExecutionError extends Error {
          code: string;
          constructor(code: string, message: string) {
            super(message);
            this.code = code;
          }
        },
      },
      "../scope-helpers.ts": {
        capLimit: (requested: unknown, max: number, fallback: number) => {
          const n = typeof requested === "number" ? requested : fallback;
          return Math.max(1, Math.min(max, n));
        },
      },
    },
  }) as unknown as {
    recruitmentTools: {
      name: string;
      execute: (ctx: { session: unknown }, args: Record<string, unknown>) => Promise<{ data: { requests: { id: string; maleBalance: number; femaleBalance: number; totalBalance: number }[] } }>;
    }[];
  };
}

test("get_recruitment_requests: maleBalance/femaleBalance/totalBalance đến từ batchComputeRequestKpis() (canonical), KHÔNG phải cột stale trả về từ listRecruitmentRequests()", async () => {
  const mod = load({
    rows: [
      {
        id: "rq1",
        requestCode: "RQ001",
        departmentId: "dept-A",
        department: "Xưởng 1",
        position: "Công nhân",
        status: "PENDING",
        requestedDate: "2026-09-01",
        expectedDate: "2026-09-30",
        maleRq: 10,
        femaleRq: 0,
        // Cột stale cố tình khác xa canonical để chứng minh route KHÔNG dùng chúng.
        maleBalance: 999,
        femaleBalance: 999,
        totalBalance: 999,
      },
    ],
    canonicalKpiByRequestId: new Map([["rq1", { maleBalance: 3, femaleBalance: 0, totalBalance: 3 }]]),
  });

  const tool = mod.recruitmentTools.find((t) => t.name === "get_recruitment_requests")!;
  const res = await tool.execute({ session: { id: "u1", role: "ADMIN" } }, {});

  assert.equal(res.data.requests.length, 1);
  assert.equal(res.data.requests[0].maleBalance, 3, "phải lấy từ canonical KPI, không phải cột stale=999");
  assert.equal(res.data.requests[0].femaleBalance, 0);
  assert.equal(res.data.requests[0].totalBalance, 3);
});

test("get_recruitment_requests: request không có trong canonical KPI map -> fallback 0 (không throw, không lộ giá trị stale)", async () => {
  const mod = load({
    rows: [
      {
        id: "rq2",
        requestCode: "RQ002",
        departmentId: "dept-A",
        department: "Xưởng 1",
        position: "Công nhân",
        status: "PENDING",
        requestedDate: null,
        expectedDate: null,
        maleRq: 5,
        femaleRq: 5,
        maleBalance: 777,
        femaleBalance: 777,
        totalBalance: 777,
      },
    ],
    canonicalKpiByRequestId: new Map(),
  });

  const tool = mod.recruitmentTools.find((t) => t.name === "get_recruitment_requests")!;
  const res = await tool.execute({ session: { id: "u1", role: "ADMIN" } }, {});

  assert.equal(res.data.requests[0].maleBalance, 0);
  assert.equal(res.data.requests[0].femaleBalance, 0);
  assert.equal(res.data.requests[0].totalBalance, 0);
});
