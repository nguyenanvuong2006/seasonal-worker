import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET/PATCH /api/fingerprint/it-code
   ------------------------------------------------------------
   Chạy trên ĐÚNG route thật, theo khuôn mẫu
   src/app/api/bulk-import/dw/route.test.ts.

   Bao phủ (review PR #60 — blocker #2 và #3):
     • BLOCKER #2 — PATCH KHÔNG được cho phép nhập IT CODE khi
       app.dwImportedAt vẫn NULL, kể cả khi dwId khớp VÀ đã có Mã số
       công nhật (dw_data.code) — bất biến bắt buộc: Nhập DW -> có Mã
       số công nhật -> mới được nhập IT CODE.
     • Hồ sơ đã bị xoá mềm (deletedAt) không được submit.
     • BLOCKER #3 — GET phải áp dụng privacy.view_cccd, mặc định ẩn CCCD.
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return chain;
}

function loadRoute(opts: {
  guardFor: (roles: string[], key: string) => Guard;
  canViewCccd?: boolean;
  scope: string[] | null;
  getRows?: Record<string, unknown>[];
  apps?: Record<string, unknown>[];
  dwRows?: Record<string, unknown>[];
  sessions?: Record<string, unknown>[];
  workers?: Record<string, unknown>[];
  activeAssignments?: Record<string, unknown>[];
  assignResult?: { ok: true } | { ok: false; error: "IT_CODE_ALREADY_ACTIVE" | "WORKER_ALREADY_HAS_ACTIVE_IT_CODE" };
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const assignCalls: Record<string, unknown>[] = [];
  const releaseCalls: Record<string, unknown>[] = [];

  const tableResults: Record<string, unknown[]> = {
    daily_applications: opts.getRows ?? opts.apps ?? [],
    dw_data: opts.dwRows ?? [],
    employment_sessions: opts.sessions ?? [],
    worker_profiles: opts.workers ?? [],
    it_code_assignments: opts.activeAssignments ?? [],
  };

  const txApi = {
    select: () => ({
      from: (table: { __table?: string }) => makeChain(tableResults[table.__table ?? ""] ?? []),
    }),
  };

  const dbStub = {
    select: () => ({
      from: (table: { __table?: string }) => makeChain(tableResults[table.__table ?? ""] ?? []),
    }),
    transaction: async (fn: (tx: typeof txApi) => Promise<unknown>) => fn(txApi),
  };

  const schemaStub = {
    dailyApplications: { __table: "daily_applications", id: {}, deptId: {}, regDate: {}, deletedAt: {}, dwImportedAt: {}, cccd: {} },
    dwData: { __table: "dw_data", id: {} },
    departments: { __table: "departments", deptName: {}, groupName: {}, id: {} },
    workerProfiles: { __table: "worker_profiles", cccd: {}, deletedAt: {}, id: {} },
    employmentSessions: { __table: "employment_sessions", id: {}, dailyApplicationId: {} },
    itCodeAssignments: { __table: "it_code_assignments", id: {}, itCode: {}, employmentSessionId: {}, releasedAt: {} },
  };

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: {
        json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
      },
    },
    "drizzle-orm": {
      and: (...c: unknown[]) => ({ op: "and", c }),
      desc: (col: unknown) => ({ op: "desc", col }),
      eq: (col: unknown, v: unknown) => ({ op: "eq", col, v }),
      inArray: (col: unknown, v: unknown) => ({ op: "inArray", col, v }),
      isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
      isNull: (col: unknown) => ({ op: "isNull", col }),
    },
    "@/db": { db: dbStub },
    "@/db/schema": schemaStub,
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => opts.guardFor(roles, key),
      getUserScope: async () => opts.scope,
      hasPermission: async () => opts.canViewCccd ?? false,
      writeAudit: async (_s: unknown, action: string, _t: string, detail: Record<string, unknown>) => {
        audits.push({ action, detail });
      },
    },
    "@/lib/data-scope": {
      scopeAllowsDepartment: (scope: string[] | null, deptId: string | null) => {
        if (scope === null) return true;
        if (!deptId) return false;
        return scope.includes(deptId);
      },
    },
    "@/lib/person-name": { normalizePersonName: (s: string) => s },
    "@/lib/date-range": {
      parseOperationalDateRange: (searchParams: { get(name: string): string | null }) => {
        const from = searchParams.get("from");
        const to = searchParams.get("to");
        const date = searchParams.get("date");
        if (from || to) return { ok: true, range: { from: from || to, to: to || from } };
        if (date) return { ok: true, range: { from: date, to: date } };
        return { ok: true, range: { from: "2026-08-17", to: "2026-08-17" } };
      },
    },
    "@/lib/daily-intake-workflow": {
      hasDailyCode: (dw: { code: string | null }) => typeof dw.code === "string" && dw.code.trim().length > 0,
      isEligibleForFingerprintQueue: (app: { dwImportedAt: unknown }, dw: { code: string | null }) =>
        app.dwImportedAt !== null && app.dwImportedAt !== undefined && typeof dw.code === "string" && dw.code.trim().length > 0,
      maskCccd: (value: string | null, canView: boolean) => {
        if (!value) return value;
        if (canView) return value;
        return value.length > 4 ? `••••••••${value.slice(-4)}` : "••••••••";
      },
    },
    "@/lib/fingerprint-it-code-list": {
      getFingerprintItCodeRows: async () => opts.getRows ?? [],
    },
    "@/lib/it-code-assignment": {
      assignItCode: async (input: Record<string, unknown>) => {
        assignCalls.push(input);
        return opts.assignResult ?? { ok: true, assignmentId: "assign-new" };
      },
      releaseItCode: async (input: Record<string, unknown>) => {
        releaseCalls.push(input);
        return { released: true, itCode: null };
      },
    },
  };

  const moduleObj = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`Unexpected require("${specifier}")`);
  };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: requireShim,
    console,
    process,
    Date,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Error,
    TypeError,
    RangeError,
    isNaN,
    parseInt,
    parseFloat,
    URL,
  });
  vm.runInContext(js, context);

  return { mod: moduleObj.exports, audits, assignCalls, releaseCalls };
}

function makeReq(body: unknown, url = "http://localhost/api/fingerprint/it-code") {
  return { json: async () => body, url } as unknown as Request;
}

const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };
const APP_ID = "11111111-1111-1111-1111-111111111111";
const DW_ID = "22222222-2222-2222-2222-222222222222";
const SESSION_ID = "33333333-3333-3333-3333-333333333333";
const WORKER_ID = "44444444-4444-4444-4444-444444444444";
const CCCD = "012345678901";
const SESSIONS = [{ id: SESSION_ID, dailyApplicationId: APP_ID }];
const WORKERS = [{ id: WORKER_ID, cccd: CCCD }];

/* ------------------------------------------------------------
   BLOCKER #2 — PATCH phải tự kiểm tra dwImportedAt != null ở SERVER,
   NGAY CẢ KHI đã có Mã số công nhật (dw_data.code) và dwId khớp.
   ------------------------------------------------------------ */
test("BLOCKER #2: có Mã số công nhật + dwId khớp NHƯNG dwImportedAt = null -> bị từ chối", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: null, dwId: DW_ID, cccd: CCCD }];
  const dwRows = [{ id: DW_ID, code: "CN-001" }];
  const { mod, assignCalls } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps, dwRows, sessions: SESSIONS, workers: WORKERS });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, itCode: "IT-99" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /Chưa được Recruiter nhập vào DW Data/);
  assert.equal(assignCalls.length, 0, "KHÔNG được ghi IT CODE khi chưa qua bước Nhập vào DW Data");
});

test("BLOCKER #2: dwImportedAt có giá trị + có Mã số công nhật -> submit IT CODE thành công qua canonical assignItCode()", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID, cccd: CCCD }];
  const dwRows = [{ id: DW_ID, code: "CN-001" }];
  const { mod, assignCalls } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps, dwRows, sessions: SESSIONS, workers: WORKERS });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, itCode: "IT-99" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean }[];
  assert.equal(results[0].ok, true);
  assert.equal(assignCalls.length, 1, "phải đi qua canonical assignItCode(), không còn raw UPDATE trực tiếp");
  assert.equal(assignCalls[0].itCode, "IT-99");
  assert.equal(assignCalls[0].workerId, WORKER_ID);
  assert.equal(assignCalls[0].employmentSessionId, SESSION_ID);
});

test("Không có Employment Session tương ứng -> bị từ chối (canonical service cần employmentSessionId)", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID, cccd: CCCD }];
  const dwRows = [{ id: DW_ID, code: "CN-001" }];
  const { mod, assignCalls } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps, dwRows, sessions: [], workers: WORKERS });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, itCode: "IT-99" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /Employment Session/);
  assert.equal(assignCalls.length, 0);
});

test("Chưa có Mã số công nhật -> bị từ chối dù dwImportedAt có giá trị", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID, cccd: CCCD }];
  const dwRows = [{ id: DW_ID, code: null }];
  const { mod, assignCalls } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps, dwRows, sessions: SESSIONS, workers: WORKERS });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, itCode: "IT-99" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /Chưa có Mã số công nhật/);
  assert.equal(assignCalls.length, 0);
});

test("Hồ sơ đã xoá mềm (deletedAt) -> bị từ chối kể cả khi hợp lệ về nghiệp vụ", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: new Date(), dwImportedAt: new Date(), dwId: DW_ID, cccd: CCCD }];
  const dwRows = [{ id: DW_ID, code: "CN-001" }];
  const { mod, assignCalls } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps, dwRows, sessions: SESSIONS, workers: WORKERS });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, itCode: "IT-99" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /Không tìm thấy hồ sơ/);
  assert.equal(assignCalls.length, 0);
});

/* ------------------------------------------------------------
   MISSION F section 39 — canonicalization semantics: clear / idempotent
   resubmit / change (release + reassign), and the IT_CODE_ALREADY_ACTIVE
   rejection surfaced back as a per-row failure reason.
   ------------------------------------------------------------ */
test("itCode rỗng -> release qua canonical releaseItCode(), không gọi assignItCode()", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID, cccd: CCCD }];
  const dwRows = [{ id: DW_ID, code: "CN-001" }];
  const { mod, assignCalls, releaseCalls } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps, dwRows, sessions: SESSIONS, workers: WORKERS });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, itCode: "" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, true);
  assert.match(results[0].reason, /xoá/i);
  assert.equal(releaseCalls.length, 1);
  assert.equal(assignCalls.length, 0);
});

test("Submit lại ĐÚNG giá trị IT Code đang active -> no-op idempotent, không gọi lại assignItCode()/releaseItCode()", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID, cccd: CCCD }];
  const dwRows = [{ id: DW_ID, code: "CN-001" }];
  const activeAssignments = [{ itCode: "IT-99" }];
  const { mod, assignCalls, releaseCalls } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps, dwRows, sessions: SESSIONS, workers: WORKERS, activeAssignments });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, itCode: "IT-99" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, true);
  assert.match(results[0].reason, /không đổi/i);
  assert.equal(assignCalls.length, 0, "resubmitting the SAME active value must not re-trigger WORKER_ALREADY_HAS_ACTIVE_IT_CODE");
  assert.equal(releaseCalls.length, 0);
});

test("Sửa đổi IT Code khác giá trị đang active -> release cái cũ RỒI assign cái mới (đúng thứ tự, cùng transaction)", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID, cccd: CCCD }];
  const dwRows = [{ id: DW_ID, code: "CN-001" }];
  const activeAssignments = [{ itCode: "IT-OLD" }];
  const { mod, assignCalls, releaseCalls } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps, dwRows, sessions: SESSIONS, workers: WORKERS, activeAssignments });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, itCode: "IT-NEW" }] }));

  const results = res.body.results as { ok: boolean }[];
  assert.equal(results[0].ok, true);
  assert.equal(releaseCalls.length, 1, "phải release assignment cũ trước");
  assert.equal(releaseCalls[0].releaseReason, "MANUAL_CORRECTION");
  assert.equal(assignCalls.length, 1, "rồi assign giá trị mới");
  assert.equal(assignCalls[0].itCode, "IT-NEW");
});

test("assignItCode() trả IT_CODE_ALREADY_ACTIVE (code đang thuộc người khác) -> surfaced đúng là 1 dòng thất bại, không crash cả batch", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID, cccd: CCCD }];
  const dwRows = [{ id: DW_ID, code: "CN-001" }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps, dwRows, sessions: SESSIONS, workers: WORKERS, assignResult: { ok: false, error: "IT_CODE_ALREADY_ACTIVE" } });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, itCode: "IT-TAKEN" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /đang được gán cho người khác/);
});

/* ------------------------------------------------------------
   BLOCKER #3 — GET phải mặc định ẩn CCCD cho role không có privacy.view_cccd.
   ------------------------------------------------------------ */
test("BLOCKER #3: GET ẩn CCCD mặc định khi role không có privacy.view_cccd", async () => {
  const getRows = [
    { dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", itCode: null, itCodeUpdatedAt: null, itCodeUpdatedBy: null },
  ];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, canViewCccd: false, scope: null, getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/fingerprint/it-code?date=2026-08-17&filter=ALL"));

  assert.equal(res.status, 200);
  const rows = res.body.rows as { cccd: string }[];
  assert.equal(rows[0].cccd, "••••••••8901");
});

test("BLOCKER #3: GET trả CCCD đầy đủ khi role CÓ privacy.view_cccd", async () => {
  const getRows = [
    { dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", itCode: null, itCodeUpdatedAt: null, itCodeUpdatedBy: null },
  ];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, canViewCccd: true, scope: null, getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/fingerprint/it-code?date=2026-08-17&filter=ALL"));

  const rows = res.body.rows as { cccd: string }[];
  assert.equal(rows[0].cccd, "012345678901");
});

/* ------------------------------------------------------------
   PHASE 7 — RBAC / Data Scope: GET với deptId ngoài phạm vi phải bị
   từ chối NGAY từ route, không được truy vấn getFingerprintItCodeRows.
   Trực tiếp thao túng deptId qua query string không được mở rộng Data Scope.
   ------------------------------------------------------------ */
test("Data Scope: Department Manager (scope=dept-A) truyền deptId=dept-B trên query string -> 403, KHÔNG rò rỉ dữ liệu ngoài phạm vi", async () => {
  const getRows = [{ dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-B", deptName: "Dept B", groupName: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", itCode: "IT-001", itCodeUpdatedAt: null, itCodeUpdatedBy: null }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: ["dept-A"], getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/fingerprint/it-code?date=2026-08-17&deptId=dept-B"));

  assert.equal(res.status, 403);
  assert.match(res.body.error as string, /Ngoài phạm vi/);
  assert.equal(res.body.rows, undefined, "response 403 KHÔNG được kèm theo dữ liệu");
});

test("Data Scope: Department Manager (scope=dept-A) truyền deptId=dept-A -> 200, được phép xem đúng phạm vi của mình", async () => {
  const getRows = [{ dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", itCode: "IT-001", itCodeUpdatedAt: null, itCodeUpdatedBy: null }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: ["dept-A"], getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/fingerprint/it-code?date=2026-08-17&deptId=dept-A"));

  assert.equal(res.status, 200);
  const rows = res.body.rows as { dailyApplicationId: string }[];
  assert.equal(rows.length, 1);
});

test("Data Scope: ADMIN/global (scope=null) không bị chặn bởi bất kỳ deptId nào", async () => {
  const getRows = [{ dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-ANY", deptName: "Dept Any", groupName: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", itCode: "IT-001", itCodeUpdatedAt: null, itCodeUpdatedBy: null }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/fingerprint/it-code?date=2026-08-17&deptId=dept-ANY"));

  assert.equal(res.status, 200);
});
