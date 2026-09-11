import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../../../lib/test-support/load-module.ts";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET /api/recruitment-requests/:id/detail
   ------------------------------------------------------------
   Canonical Request Detail (Phase 2B mục 4.3). Bao phủ:
     • Scenario G (mission mục 10.G) — Data Scope: request ngoài phạm vi
       -> 404 (không lộ tồn tại), KHÔNG gọi getRequestDetail() đầy đủ.
     • asOf mặc định: request EXPIRED dùng resolveDefaultAsOf(endDate),
       KHÔNG dùng today; request PENDING dùng today.
     • asOf query string override hoạt động đúng.

   FILE ĐẶT Ở ĐÂY (KHÔNG nằm trong thư mục "[id]/detail/" nơi route.ts thật
   sự sống): `node --test` (kể cả khi được truyền path tường minh, như
   `npm test` đang dùng qua `find src -name '*.test.ts'`) không phát hiện
   được file test nằm trong thư mục có dấu ngoặc vuông trong tên — path
   `[id]` bị hiểu nhầm thành character-class glob nên bị lọc bỏ ÂM THẦM
   (import trực tiếp file thì chạy đúng, nhưng qua `node --test <path>` thì
   0 test được ghi nhận, không có lỗi nào được báo). Đã verify: đây là quirk
   của Node test runner với TÊN THƯ MỤC chứa "[...]" (Next.js dynamic route
   segment), không phải lỗi của route.ts hay loadModule(). Không có
   route.test.ts nào khác trong repo từng đặt trực tiếp bên trong 1 thư mục
   "[...]" — quy ước đúng là đặt ở thư mục cha và import route.ts bằng
   đường dẫn tương đối, như file này.
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

function loadRoute(opts: {
  guardFor?: (roles: string[], key: string) => Guard;
  scope: string[] | null;
  row: { id: string; departmentId: string | null; status: string; endDate: string | null; completedDate: string | null; updatedAt: Date } | null;
}) {
  const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };
  const detailCalls: { id: string; asOf?: string }[] = [];

  return {
    mod: loadModule(new URL("./[id]/detail/route.ts", import.meta.url), {
      stubs: {
        "next/server": {
          NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) },
        },
        "@/lib/auth": {
          requirePermission: async (roles: string[], key: string) => (opts.guardFor ? opts.guardFor(roles, key) : ADMIN_GUARD),
          getUserScope: async () => opts.scope,
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

test("Scenario G: request ngoài Data Scope -> 404, KHÔNG lộ có tồn tại hay không", async () => {
  const { mod, detailCalls } = loadRoute({
    scope: ["dept-A"],
    row: { id: "rq09", departmentId: "dept-OUTSIDE", status: "PENDING", endDate: null, completedDate: null, updatedAt: new Date() },
  });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/recruitment-requests/rq09/detail"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(res.status, 404);
  assert.equal(detailCalls.length, 0, "không được gọi getRequestDetail() khi đã fail Data Scope");
});

test("request PENDING (đang mở) -> asOf mặc định = today", async () => {
  const { mod, detailCalls } = loadRoute({
    scope: null,
    row: { id: "rq10", departmentId: "dept-A", status: "PENDING", endDate: null, completedDate: null, updatedAt: new Date() },
  });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/recruitment-requests/rq10/detail"), { params: Promise.resolve({ id: "rq10" }) });

  assert.equal(res.status, 200);
  assert.equal(detailCalls[0].asOf, "2026-10-15");
  assert.equal(res.body.asOf, "2026-10-15");
  // Final pre-merge review finding (BLOCKER, fixed pre-merge): isLive must be computed
  // server-side (asOf === todayStr(), Vietnam-local) and handed to the client as data —
  // the client must NEVER derive "today" itself via `new Date()` (browser UTC calendar
  // day), which drifts from Vietnam-local for ~7 hours every day (00:00–06:59 ICT) and
  // would wrongly show a live/open request as "Cuối kỳ (Closing Workforce)".
  assert.equal(res.body.isLive, true, "request đang mở, asOf=today -> isLive=true");
});

test("request EXPIRED -> asOf mặc định = endDate (đóng băng), KHÔNG dùng today", async () => {
  const { mod, detailCalls } = loadRoute({
    scope: null,
    row: { id: "rq09", departmentId: "dept-A", status: "EXPIRED", endDate: "2026-09-30", completedDate: null, updatedAt: new Date() },
  });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/recruitment-requests/rq09/detail"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(res.status, 200);
  assert.equal(detailCalls[0].asOf, "2026-09-30");
  assert.notEqual(detailCalls[0].asOf, "2026-10-15", "request đã hết hạn không được dùng today làm asOf mặc định");
  assert.equal(res.body.isLive, false, "request đã đóng băng, asOf != today -> isLive=false, KHÔNG được suy ra sai bởi client tự tính today()");
});

test("?asOf= query string override đúng mặc định", async () => {
  const { mod, detailCalls } = loadRoute({
    scope: null,
    row: { id: "rq09", departmentId: "dept-A", status: "EXPIRED", endDate: "2026-09-30", completedDate: null, updatedAt: new Date() },
  });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
  await GET(makeReq("http://localhost/api/recruitment-requests/rq09/detail?asOf=2026-09-15"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(detailCalls[0].asOf, "2026-09-15");
});

test("permission gate: role không có planning.view -> lỗi từ requirePermission, không truy vấn gì", async () => {
  const { mod, detailCalls } = loadRoute({
    guardFor: () => ({ ok: false, status: 403, error: "Không có quyền." }),
    scope: null,
    row: null,
  });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/recruitment-requests/rq09/detail"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(res.status, 403);
  assert.equal(detailCalls.length, 0);
});
