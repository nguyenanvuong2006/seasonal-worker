import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../../../lib/test-support/load-module.ts";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET /api/workforce-requests/:id
   ------------------------------------------------------------
   Phase 2B mục 4.4: dùng CHUNG getRequestDetail()/resolveDefaultAsOf() với
   canonical /api/recruitment-requests/:id/detail — bao phủ:
     • Data Scope: request ngoài phạm vi -> 404, KHÔNG gọi getRequestDetail().
     • asOf mặc định EXPIRED = endDate (đóng băng), KHÔNG dùng today.

   FILE ĐẶT NGOÀI thư mục "[id]/" (không phải trong đó) — `node --test`
   không phát hiện được test file nằm trong thư mục có "[...]" trong tên
   (đã verify ở recruitment-requests/detail-route.test.ts).
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

function loadRoute(opts: {
  scope: string[] | null;
  row: { id: string; departmentId: string | null; status: string; endDate: string | null; completedDate: string | null; updatedAt: Date } | null;
}) {
  const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };
  const detailCalls: { id: string; asOf?: string }[] = [];

  return {
    mod: loadModule(new URL("./[id]/route.ts", import.meta.url), {
      stubs: {
        "next/server": {
          NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) },
        },
        "@/lib/auth": {
          requirePermission: async () => ADMIN_GUARD,
          getUserScope: async () => opts.scope,
          hasPermission: async () => false,
          writeAudit: async () => undefined,
        },
        "@/lib/data-scope": {
          scopeAllowsDepartment: (scope: string[] | null, deptId: string | null) => {
            if (scope === null) return true;
            if (!deptId) return false;
            return scope.includes(deptId);
          },
        },
        "@/lib/recruitment-request": {
          getRecruitmentRequest: async () => opts.row,
        },
        "@/lib/workforce-request": {
          getRequestDetail: async (id: string, asOf?: string) => {
            detailCalls.push({ id, asOf });
            if (!opts.row) return null;
            return { request: opts.row, kpi: {}, resignedWorkers: [], transferredWorkers: [], currentWorkers: [] };
          },
          linkRequestToPlanningPeriod: async () => undefined,
        },
        "@/lib/workforce-request-kpi": {
          resolveDefaultAsOf: (r: { status: string; endDate: string | null; completedDate: string | null; updatedAt: Date }, today: string) => {
            if (r.status === "EXPIRED" || r.status === "COMPLETED" || r.status === "CANCELLED") {
              return r.endDate ?? r.completedDate ?? r.updatedAt.toISOString().slice(0, 10);
            }
            return today;
          },
        },
        "@/lib/helpers": { todayStr: () => "2026-10-15" },
      },
    }),
    detailCalls,
  };
}

function makeReq(url: string) {
  return { url } as unknown as Request;
}

test("Data Scope: request ngoài phạm vi -> 404, KHÔNG gọi getRequestDetail()", async () => {
  const { mod, detailCalls } = loadRoute({
    scope: ["dept-A"],
    row: { id: "rq09", departmentId: "dept-OUTSIDE", status: "PENDING", endDate: null, completedDate: null, updatedAt: new Date() },
  });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number }>;
  const res = await GET(makeReq("http://localhost/api/workforce-requests/rq09"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(res.status, 404);
  assert.equal(detailCalls.length, 0);
});

test("request EXPIRED -> asOf mặc định = endDate, KHÔNG dùng today (dùng CHUNG resolveDefaultAsOf với canonical route)", async () => {
  const { mod, detailCalls } = loadRoute({
    scope: null,
    row: { id: "rq09", departmentId: "dept-A", status: "EXPIRED", endDate: "2026-09-30", completedDate: null, updatedAt: new Date() },
  });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number }>;
  const res = await GET(makeReq("http://localhost/api/workforce-requests/rq09"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(res.status, 200);
  assert.equal(detailCalls[0].asOf, "2026-09-30");
});
