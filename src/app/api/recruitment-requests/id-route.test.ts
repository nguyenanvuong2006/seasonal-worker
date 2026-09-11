import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, eqValue, type FakeDb, type QueryCall } from "../../../lib/test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../../../lib/test-support/load-module.ts";
import { isFemale, isMale, todayStr } from "../../../lib/helpers.ts";
import {
  REQUEST_STATUSES,
  computeDateDeltas,
  computeRecruitedVsExpected,
  computeTotalRequest,
  stripSystemOwnedFields,
} from "../../../lib/planning-recruitment-core.ts";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — PATCH /api/recruitment-requests/:id (action=update)
   ------------------------------------------------------------
   Final project hardening — Regression cho bug: recruitedVsExpected
   ("Đã tuyển / Kế hoạch") bị tính từ existing.maleRecruited/femaleRecruited,
   hai cột KHÔNG BAO GIỜ được ghi giá trị khác 0 ở bất kỳ nơi nào trong
   codebase (chỉ khởi tạo = 0 lúc tạo request) — nên mọi lần sửa thủ công
   qua UI đều âm thầm reset KPI này về 0%, dù daily_applications thực tế
   đã có ứng viên ở trạng thái RECRUITED_STAGE. Fix: tính LIVE từ
   daily_applications (giống hệt nguồn import-update path đã dùng).

   FILE ĐẶT Ở THƯ MỤC CHA (không phải trong "[id]/"): xem giải thích quy
   ước trong detail-route.test.ts — node --test bỏ sót thư mục có "[...]".
   ============================================================ */

const dailyApplications = makeTable("daily_applications");
const recruitmentRequests = makeTable("recruitment_requests");

type Guard =
  | { ok: true; session: { id: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

function loadRoute(opts: {
  existing: { id: string; departmentId: string | null; status: string; requestCode: string; maleRq: number; femaleRq: number; maleRecruited: number; femaleRecruited: number; [k: string]: unknown };
  recruitedRows: { gender: string }[];
}) {
  const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };
  const provisionCalls: unknown[] = [];
  const auditCalls: unknown[] = [];

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.table === "daily_applications" && call.root === "select") {
        return opts.recruitedRows;
      }
      if (call.table === "recruitment_requests" && call.root === "select") {
        return [{ ...opts.existing }];
      }
      return undefined;
    },
  });

  const mod = loadModule(new URL("./[id]/route.ts", import.meta.url), {
    stubs: {
      "next/server": {
        NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) },
      },
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": { dailyApplications, recruitmentRequests },
      "@/lib/auth": {
        requirePermission: async () => ADMIN_GUARD,
        getUserScope: async () => null,
        hasPermission: async () => true,
        writeAudit: async (...args: unknown[]) => {
          auditCalls.push(args);
        },
      },
      "@/lib/data-scope": { scopeAllowsDepartment: () => true },
      "@/lib/recruitment-request": {
        getRecruitmentRequest: async () => opts.existing,
        batchUpdateStatus: async () => undefined,
        softDeleteRecruitmentRequests: async () => undefined,
      },
      "@/lib/planning-reallocation": { listOpenAllocationsForRequest: async () => [] },
      "@/lib/planning-recruitment-core": {
        REQUEST_STATUSES,
        computeDateDeltas,
        computeRecruitedVsExpected,
        computeTotalRequest,
        stripSystemOwnedFields,
      },
      "@/lib/recruitment-request-provisioning": {
        provisionRecruitmentRequest: async (...args: unknown[]) => {
          provisionCalls.push(args);
        },
      },
      "@/lib/workforce-request": { batchComputeRequestKpis: async () => new Map(), RECRUITED_STAGE: "APPROVED" },
      "@/lib/workforce-request-kpi": { resolveDefaultAsOf: () => todayStr() },
      "@/lib/helpers": { isFemale, isMale, todayStr },
    },
  });
  return { mod, db, provisionCalls, auditCalls };
}

function makeReq(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request;
}

test("PATCH action=update: recruitedVsExpected tính LIVE từ daily_applications (RECRUITED_STAGE), KHÔNG dùng existing.maleRecruited/femaleRecruited (2 cột không bao giờ được ghi khác 0)", async () => {
  const { mod, db } = loadRoute({
    existing: {
      id: "rq1",
      departmentId: "dept-A",
      status: "PENDING",
      requestCode: "RQ001",
      maleRq: 5,
      femaleRq: 5,
      // Cố tình đặt maleRecruited/femaleRecruited = 0 (giá trị thật sự luôn có trong DB)
      // để chứng minh route KHÔNG dùng 2 cột này — nếu bug tái diễn thì recruitedVsExpected
      // sẽ ra 0% dù daily_applications có 4 ứng viên RECRUITED.
      maleRecruited: 0,
      femaleRecruited: 0,
    },
    // 4 ứng viên thật đã RECRUITED (APPROVED) cho request này -> 4/10 = 40%.
    recruitedRows: [{ gender: "Nam" }, { gender: "Nam" }, { gender: "Nữ" }, { gender: "Nữ" }],
  });

  const PATCH = mod.PATCH as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ action: "update", fields: { location: "Xưởng 1" } }), { params: Promise.resolve({ id: "rq1" }) });

  assert.equal(res.status, 200);
  const updateCall = db.calls.find((c) => c.table === "recruitment_requests" && c.root === "update");
  assert.ok(updateCall, "phải có UPDATE recruitment_requests");
  const patch = updateCall!.ops.find((o) => o.fn === "set")?.args[0] as Record<string, unknown>;
  assert.equal(patch.recruitedVsExpected, 40, "4 recruited / 10 total request = 40%, tính LIVE từ daily_applications — không phải 0% từ cột stale");
});

test("PATCH action=update: không có ứng viên RECRUITED nào -> recruitedVsExpected = 0% (đúng, không phải bug)", async () => {
  const { mod, db } = loadRoute({
    existing: { id: "rq2", departmentId: "dept-A", status: "PENDING", requestCode: "RQ002", maleRq: 3, femaleRq: 0, maleRecruited: 0, femaleRecruited: 0 },
    recruitedRows: [],
  });

  const PATCH = mod.PATCH as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ action: "update", fields: { location: "Xưởng 2" } }), { params: Promise.resolve({ id: "rq2" }) });

  assert.equal(res.status, 200);
  const updateCall = db.calls.find((c) => c.table === "recruitment_requests" && c.root === "update");
  const patch = updateCall!.ops.find((o) => o.fn === "set")?.args[0] as Record<string, unknown>;
  assert.equal(patch.recruitedVsExpected, 0);
});
