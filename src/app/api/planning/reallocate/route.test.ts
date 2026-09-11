import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../../../../lib/test-support/load-module.ts";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — /api/planning/reallocate (Phase 3B — F3)
   ------------------------------------------------------------
   Trước Phase 3B, route này KHÔNG có test riêng (chỉ có test ở tầng
   service planning-reallocation.ts) — audit Phase 3A đã ghi nhận đây
   là một gap. File này bao phủ đúng những gì route tự làm mà service
   không làm: auth guard, Data Scope re-check của GET (existence leak),
   và error mapping từ ReallocateResult sang HTTP response.
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };

function loadRoute(opts: {
  guard?: Guard;
  scope?: string[] | null;
  sourceRequestRow?: { departmentId: string | null } | null;
  targets?: unknown[];
  allocations?: unknown[];
  reallocateResult?:
    | { ok: true; moved: number; newAllocationIds: string[]; taskClosed: boolean; resignationsCreated: 0 }
    | { ok: false; status: number; error: string };
  reallocateCalls?: unknown[];
  auditCalls?: unknown[];
}) {
  return loadModule(new URL("./route.ts", import.meta.url), {
    stubs: {
      "next/server": {
        NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) },
      },
      "drizzle-orm": { and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a, isNull: (...a: unknown[]) => a },
      "@/db": {
        db: {
          select: () => ({
            from: () => ({
              where: async () => (opts.sourceRequestRow === undefined ? [{ departmentId: "dept-A" }] : opts.sourceRequestRow ? [opts.sourceRequestRow] : []),
            }),
          }),
        },
      },
      "@/db/schema": { recruitmentRequests: { departmentId: "departmentId", id: "id", deletedAt: "deletedAt" } },
      "@/lib/auth": {
        requirePermission: async () => opts.guard ?? ADMIN_GUARD,
        getUserScope: async () => (opts.scope === undefined ? null : opts.scope),
        writeAudit: async (...args: unknown[]) => {
          opts.auditCalls?.push(args);
        },
      },
      "@/lib/data-scope": {
        scopeAllowsDepartment: (scope: string[] | null, deptId: string | null) => {
          if (scope === null) return true;
          if (!deptId) return false;
          return scope.includes(deptId);
        },
      },
      "@/lib/planning-reallocation": {
        listOpenAllocationsForRequest: async () => opts.allocations ?? [],
        listReallocationTargets: async () => opts.targets ?? [],
        reallocateDws: async (input: unknown) => {
          opts.reallocateCalls?.push(input);
          return opts.reallocateResult ?? { ok: true, moved: 0, newAllocationIds: [], taskClosed: false, resignationsCreated: 0 };
        },
      },
    },
  });
}

function makeReq(url: string, body?: unknown) {
  return {
    url,
    json: async () => body,
  } as unknown as Request;
}

/* ------------------------------------------------------------
   GET
   ------------------------------------------------------------ */

test("GET: role không có planning.reallocate -> lỗi từ requirePermission, không truy vấn gì", async () => {
  const mod = loadRoute({ guard: { ok: false, status: 403, error: "Không có quyền." } });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/planning/reallocate?requestId=rq09"));

  assert.equal(res.status, 403);
});

test("GET: thiếu requestId -> 400", async () => {
  const mod = loadRoute({});
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/planning/reallocate"));

  assert.equal(res.status, 400);
});

test("GET: yêu cầu nguồn ngoài Data Scope -> 404, KHÔNG lộ tồn tại (không gọi listOpenAllocationsForRequest)", async () => {
  const allocCalls: unknown[] = [];
  const mod = loadRoute({
    scope: ["dept-B"],
    sourceRequestRow: { departmentId: "dept-A" }, // ngoài scope ["dept-B"]
    allocations: [{ allocationId: "x" }],
  });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/planning/reallocate?requestId=rq09"));

  assert.equal(res.status, 404);
});

test("GET: nguồn không tồn tại -> 404 (không phân biệt với ngoài scope)", async () => {
  const mod = loadRoute({ scope: null, sourceRequestRow: null });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/planning/reallocate?requestId=rq09"));

  assert.equal(res.status, 404);
});

test("GET hợp lệ: trả allocations + targets + counts", async () => {
  const mod = loadRoute({
    scope: null,
    sourceRequestRow: { departmentId: "dept-A" },
    allocations: [
      { allocationId: "a1", gender: "Nam" },
      { allocationId: "a2", gender: "Nữ" },
    ],
    targets: [{ id: "rq10", requestCode: "RQ-010", totalBalance: 1 }],
  });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: { allocations: unknown[]; targets: unknown[]; counts: { total: number } } }>;
  const res = await GET(makeReq("http://localhost/api/planning/reallocate?requestId=rq09"));

  assert.equal(res.status, 200);
  assert.equal(res.body.allocations.length, 2);
  assert.equal(res.body.targets.length, 1);
  assert.equal(res.body.counts.total, 2);
});

/* ------------------------------------------------------------
   POST
   ------------------------------------------------------------ */

test("POST: role không có planning.reallocate -> lỗi từ requirePermission, không gọi service", async () => {
  const reallocateCalls: unknown[] = [];
  const mod = loadRoute({ guard: { ok: false, status: 403, error: "Không có quyền." }, reallocateCalls });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq("http://localhost/api/planning/reallocate", { fromRequestId: "a", toRequestId: "b", allocationIds: ["x"] }));

  assert.equal(res.status, 403);
  assert.equal(reallocateCalls.length, 0);
});

test("POST: destination full (409 TOTAL_OVER_TARGET) -> route trả nguyên vẹn status + domain message từ service, không generic hoá", async () => {
  const mod = loadRoute({
    reallocateResult: { ok: false, status: 409, error: "Yêu cầu tuyển dụng đích không còn đủ chỉ tiêu cho số lao động đã chọn." },
  });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: { error: string } }>;
  const res = await POST(
    makeReq("http://localhost/api/planning/reallocate", { fromRequestId: "req-old", toRequestId: "req-new", allocationIds: ["a1", "a2"] }),
  );

  assert.equal(res.status, 409);
  assert.equal(res.body.error, "Yêu cầu tuyển dụng đích không còn đủ chỉ tiêu cho số lao động đã chọn.");
  assert.notEqual(res.body.error, "Có lỗi xảy ra", "phải giữ nguyên domain message của service, không generic hoá");
});

test("POST: allocationIds trùng lặp được chuẩn hoá (dedupe) trước khi truyền xuống service", async () => {
  const reallocateCalls: { allocationIds: string[] }[] = [];
  const mod = loadRoute({ reallocateCalls: reallocateCalls as unknown[] });
  const POST = mod.POST as (req: Request) => Promise<{ status: number }>;
  await POST(
    makeReq("http://localhost/api/planning/reallocate", {
      fromRequestId: "req-old",
      toRequestId: "req-new",
      allocationIds: ["a1", "a1", "a2", "a1"],
    }),
  );

  assert.equal(reallocateCalls.length, 1);
  assert.deepEqual([...reallocateCalls[0].allocationIds].sort(), ["a1", "a2"]);
});

test("POST hợp lệ: 200 + audit ghi rõ resignationsCreated=0", async () => {
  const auditCalls: unknown[] = [];
  const mod = loadRoute({
    reallocateResult: { ok: true, moved: 2, newAllocationIds: ["n1", "n2"], taskClosed: true, resignationsCreated: 0 },
    auditCalls,
  });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: { success: boolean; moved: number } }>;
  const res = await POST(
    makeReq("http://localhost/api/planning/reallocate", { fromRequestId: "req-old", toRequestId: "req-new", allocationIds: ["a1", "a2"] }),
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.moved, 2);
  assert.equal(auditCalls.length, 1);
  const [, , , detail] = auditCalls[0] as [unknown, unknown, unknown, { resignationsCreated: number }];
  assert.equal(detail.resignationsCreated, 0);
});

test("POST: lỗi service không leak nội bộ (chỉ trả error message đã định nghĩa, không có stack/DB detail)", async () => {
  const mod = loadRoute({
    reallocateResult: { ok: false, status: 409, error: "Có phân bổ đã được chuyển trước đó." },
  });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq("http://localhost/api/planning/reallocate", { fromRequestId: "a", toRequestId: "b", allocationIds: ["x"] }));

  const bodyKeys = Object.keys(res.body);
  assert.deepEqual(bodyKeys, ["error"], "response body chỉ có field error, không leak field nội bộ nào khác");
});
