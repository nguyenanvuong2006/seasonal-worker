import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../../../lib/test-support/load-module.ts";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET /api/recruitment-requests/:id/export
   ------------------------------------------------------------
   Canonical Request Detail export (Phase 2B mục 6). Bao phủ:
     • Data Scope: request ngoài phạm vi -> 404, KHÔNG gọi getRequestDetail().
     • asOf mặc định: EXPIRED dùng endDate (đóng băng), PENDING dùng today —
       GIỐNG HỆT canonical detail route (cùng nguồn resolveDefaultAsOf).
     • Filename: RQ{code}_{deptSlug}_{YYYY-MM}.xlsx, sanitize đúng.
     • Audit được ghi mỗi lần export thành công.
     • permission gate: không có planning.view -> lỗi, không truy vấn gì.

   FILE ĐẶT Ở ĐÂY (không nằm trong "[id]/export/") — cùng lý do đã ghi ở
   detail-route.test.ts: `node --test` không phát hiện test file nằm trong
   thư mục có "[...]" trong tên.
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

type FakeRequestDetail = {
  request: {
    id: string;
    requestCode: string;
    requester: string;
    department: string | null;
    deptName: string | null;
    status: string;
    endDate: string | null;
    completedDate: string | null;
    requestedDate: string | null;
    expectedDate: string | null;
    month: string | null;
    updatedAt: Date;
    createdAt: Date;
    departmentId: string | null;
  };
  kpi: Record<string, number>;
  pipeline: unknown[];
  currentWorkers: unknown[];
  resignedWorkers: unknown[];
  transferredWorkers: unknown[];
  history: unknown[];
};

function loadRoute(opts: {
  guardFor?: (roles: string[], key: string) => Guard;
  scope: string[] | null;
  row: FakeRequestDetail["request"] | null;
  detail?: FakeRequestDetail | null;
}) {
  const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };
  const detailCalls: { id: string; asOf?: string }[] = [];
  const audits: { action: string; details: Record<string, unknown> }[] = [];
  const sheets: { sheetName: string; rows: unknown[] }[] = [];

  const mod = loadModule(new URL("./[id]/export/route.ts", import.meta.url), {
    stubs: {
      "next/server": {
        NextResponse: class {
          status: number;
          body: unknown;
          headers: Record<string, string>;
          constructor(body: unknown, init?: { headers?: Record<string, string>; status?: number }) {
            this.body = body;
            this.status = init?.status ?? 200;
            this.headers = init?.headers ?? {};
          }
          static json(body: Record<string, unknown>, init?: { status?: number }) {
            return { status: init?.status ?? 200, body };
          }
        },
      },
      "@/lib/auth": {
        requirePermission: async (roles: string[], key: string) => (opts.guardFor ? opts.guardFor(roles, key) : ADMIN_GUARD),
        getUserScope: async () => opts.scope,
        writeAudit: async (_s: unknown, action: string, _t: string, details: Record<string, unknown>) => {
          audits.push({ action, details });
        },
      },
      "@/lib/data-scope": {
        scopeAllowsDepartment: (scope: string[] | null, deptId: string | null) => {
          if (scope === null) return true;
          if (!deptId) return false;
          return scope.includes(deptId);
        },
      },
      "@/lib/document-merge/filename": {
        sanitizeFilenameSegment: (input: string) =>
          String(input ?? "")
            .normalize("NFC")
            .replace(/[^\w-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, ""),
      },
      "@/lib/excel-workbook-style": {
        createStyledWorkbook: () => ({ __fake: "workbook" }),
        addStyledSheet: (_wb: unknown, o: { sheetName: string; rows: unknown[] }) => {
          sheets.push({ sheetName: o.sheetName, rows: o.rows });
        },
        workbookToBuffer: async () => Buffer.from("fake-xlsx"),
      },
      "@/lib/recruitment-request": {
        getRecruitmentRequest: async () => opts.row,
      },
      "@/lib/workforce-request": {
        getRequestDetail: async (id: string, asOf?: string) => {
          detailCalls.push({ id, asOf });
          return opts.detail ?? null;
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
  });

  return { mod, detailCalls, audits, sheets };
}

function makeReq(url: string) {
  return { url } as unknown as Request;
}

function baseRow(overrides: Partial<FakeRequestDetail["request"]> = {}): FakeRequestDetail["request"] {
  return {
    id: "rq09",
    requestCode: "RQ-2026-09",
    requester: "Trần B",
    department: "Đóng gói",
    deptName: "Đóng gói",
    status: "PENDING",
    endDate: null,
    completedDate: null,
    requestedDate: "2026-09-01",
    expectedDate: null,
    month: "2026-09",
    updatedAt: new Date("2026-09-10"),
    createdAt: new Date("2026-09-01"),
    departmentId: "dept-A",
    ...overrides,
  };
}

function baseDetail(row: FakeRequestDetail["request"]): FakeRequestDetail {
  return {
    request: row,
    kpi: {
      maleRequest: 5,
      femaleRequest: 3,
      totalRequest: 8,
      maleCurrent: 2,
      femaleCurrent: 1,
      totalCurrent: 3,
      maleRecruited: 3,
      femaleRecruited: 2,
      totalRecruited: 5,
      maleQuit: 1,
      femaleQuit: 0,
      totalQuit: 1,
      maleTransferOut: 0,
      femaleTransferOut: 1,
      totalTransferOut: 1,
      maleBalance: 3,
      femaleBalance: 2,
      totalBalance: 5,
      fillRatePercent: 37.5,
    },
    pipeline: [{ status: "APPROVED", male: 3, female: 2, total: 5 }],
    currentWorkers: [{ workerName: "Nguyen Van A", gender: "MALE", deptName: "Đóng gói", allocatedAt: new Date("2026-09-02"), allocatedBy: "hr1" }],
    resignedWorkers: [{ workerName: "Le Thi C", gender: "FEMALE", effectiveDate: "2026-09-05", reason: "Cá nhân" }],
    transferredWorkers: [{ workerName: "Pham D", gender: "MALE", effectiveDate: "2026-09-06", fromDeptName: "Đóng gói", toDeptName: "Trồng trọt", destinationRequestCode: "RQ-2026-10" }],
    history: [{ action: "ALLOCATE", workerName: "Nguyen Van A", fromRequestId: null, toRequestId: "rq09", reason: null, changedBy: "hr1", changedAt: new Date("2026-09-02") }],
  };
}

test("Data Scope: request ngoài phạm vi -> 404, KHÔNG gọi getRequestDetail(), KHÔNG xuất file", async () => {
  const row = baseRow({ departmentId: "dept-OUTSIDE" });
  const { mod, detailCalls } = loadRoute({ scope: ["dept-A"], row, detail: baseDetail(row) });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number }>;
  const res = await GET(makeReq("http://localhost/api/recruitment-requests/rq09/export"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(res.status, 404);
  assert.equal(detailCalls.length, 0);
});

test("permission gate: không có planning.view -> lỗi, không truy vấn gì", async () => {
  const { mod, detailCalls } = loadRoute({ guardFor: () => ({ ok: false, status: 403, error: "Không có quyền." }), scope: null, row: null });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number }>;
  const res = await GET(makeReq("http://localhost/api/recruitment-requests/rq09/export"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(res.status, 403);
  assert.equal(detailCalls.length, 0);
});

test("request PENDING (đang mở) -> asOf mặc định = today, export thành công, audit được ghi", async () => {
  const row = baseRow({ status: "PENDING" });
  const { mod, detailCalls, audits } = loadRoute({ scope: null, row, detail: baseDetail(row) });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; headers: Record<string, string> }>;
  const res = await GET(makeReq("http://localhost/api/recruitment-requests/rq09/export"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(res.status, 200);
  assert.equal(detailCalls[0].asOf, "2026-10-15");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "EXPORT_RECRUITMENT_REQUEST_DETAIL");
});

test("request EXPIRED -> asOf mặc định = endDate (đóng băng), KHÔNG dùng today", async () => {
  const row = baseRow({ status: "EXPIRED", endDate: "2026-09-30" });
  const { mod, detailCalls } = loadRoute({ scope: null, row, detail: baseDetail(row) });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number }>;
  await GET(makeReq("http://localhost/api/recruitment-requests/rq09/export"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(detailCalls[0].asOf, "2026-09-30");
});

test("?asOf= query string override đúng mặc định", async () => {
  const row = baseRow({ status: "EXPIRED", endDate: "2026-09-30" });
  const { mod, detailCalls } = loadRoute({ scope: null, row, detail: baseDetail(row) });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number }>;
  await GET(makeReq("http://localhost/api/recruitment-requests/rq09/export?asOf=2026-09-15"), { params: Promise.resolve({ id: "rq09" }) });

  assert.equal(detailCalls[0].asOf, "2026-09-15");
});

test("filename: RQ{code}_{deptSlug}_{YYYY-MM}.xlsx, sanitize đúng, không có dấu/khoảng trắng", async () => {
  const row = baseRow({ requestCode: "RQ 2026/09 Đóng gói!", deptName: "Đóng gói & Vận chuyển", month: "2026-09" });
  const { mod } = loadRoute({ scope: null, row, detail: baseDetail(row) });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; headers: Record<string, string> }>;
  const res = await GET(makeReq("http://localhost/api/recruitment-requests/rq09/export"), { params: Promise.resolve({ id: "rq09" }) });

  const disposition = res.headers["Content-Disposition"];
  assert.ok(disposition.includes(".xlsx"));
  assert.ok(disposition.startsWith('attachment; filename="RQ'));
  assert.ok(!/[đĐ\s/!&]/.test(disposition.split('filename="')[1].split('"')[0]), "filename ASCII phải sạch, không dấu/khoảng trắng/ký tự đặc biệt");
  assert.ok(disposition.includes("2026-09"), "filename phải chứa tháng YYYY-MM của request");
});

test("request không tồn tại -> 404", async () => {
  const { mod, detailCalls } = loadRoute({ scope: null, row: null });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number }>;
  const res = await GET(makeReq("http://localhost/api/recruitment-requests/nope/export"), { params: Promise.resolve({ id: "nope" }) });

  assert.equal(res.status, 404);
  assert.equal(detailCalls.length, 0);
});

test("mỗi sheet nhận đúng rows từ getRequestDetail() (Summary/Recruited/Resigned/Transferred Out/Current Workforce/Allocation History) — không tính KPI lần 2", async () => {
  const row = baseRow();
  const detail = baseDetail(row);
  const { mod, sheets } = loadRoute({ scope: null, row, detail });
  const GET = mod.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number }>;
  await GET(makeReq("http://localhost/api/recruitment-requests/rq09/export"), { params: Promise.resolve({ id: "rq09" }) });

  const byName = new Map(sheets.map((s) => [s.sheetName, s.rows]));
  assert.equal(byName.get("Recruited")!.length, detail.pipeline.length);
  assert.equal(byName.get("Resigned")!.length, detail.resignedWorkers.length);
  assert.equal(byName.get("Transferred Out")!.length, detail.transferredWorkers.length);
  assert.equal(byName.get("Current Workforce")!.length, detail.currentWorkers.length);
  assert.equal(byName.get("Allocation History")!.length, detail.history.length);
});
