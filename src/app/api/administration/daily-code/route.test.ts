import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET/PATCH /api/administration/daily-code
   ------------------------------------------------------------
   Chạy trên ĐÚNG route thật, theo khuôn mẫu
   src/app/api/bulk-import/dw/route.test.ts.

   Bao phủ (review PR #60 — blocker #1 và #3):
     • BLOCKER #1 — PATCH KHÔNG được tin theo dwDataId do client gửi: phải
       tự kiểm tra lại app.dwImportedAt != null ở SERVER, kể cả khi dwId
       khớp (trường hợp người DW cũ đã có dwId từ đăng ký nhưng CHƯA từng
       qua hành động "Nhập vào DW Data" tường minh).
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
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const dwUpdates: { set: Record<string, unknown> }[] = [];

  const tableResults: Record<string, unknown[]> = {
    daily_applications: opts.getRows ?? opts.apps ?? [],
  };

  const txApi = {
    update: (table: { __table?: string }) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          if (table.__table === "dw_data") dwUpdates.push({ set });
          return { rowCount: 1 };
        },
      }),
    }),
  };

  const dbStub = {
    select: () => ({
      from: (table: { __table?: string }) => makeChain(tableResults[table.__table ?? ""] ?? []),
    }),
    transaction: async (fn: (tx: typeof txApi) => Promise<unknown>) => fn(txApi),
  };

  const schemaStub = {
    dailyApplications: { __table: "daily_applications", id: {}, deptId: {}, regDate: {}, deletedAt: {}, dwImportedAt: {} },
    dwData: { __table: "dw_data", id: {} },
    departments: { __table: "departments", deptName: {}, groupName: {}, id: {} },
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
    "@/lib/helpers": { todayStr: () => "2026-08-17" },
    "@/lib/daily-intake-workflow": {
      maskCccd: (value: string | null, canView: boolean) => {
        if (!value) return value;
        if (canView) return value;
        return value.length > 4 ? `••••••••${value.slice(-4)}` : "••••••••";
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

  return { mod: moduleObj.exports, audits, dwUpdates };
}

function makeReq(body: unknown, url = "http://localhost/api/administration/daily-code") {
  return { json: async () => body, url } as unknown as Request;
}

const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };
const APP_ID = "11111111-1111-1111-1111-111111111111";
const DW_ID = "22222222-2222-2222-2222-222222222222";

/* ------------------------------------------------------------
   BLOCKER #1 — PATCH phải tự kiểm tra dwImportedAt != null ở SERVER.
   ------------------------------------------------------------ */
test("BLOCKER #1: dwId khớp NHƯNG dwImportedAt = null -> bị từ chối, KHÔNG được submit", async () => {
  const apps = [
    { id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: null, dwId: DW_ID },
  ];
  const { mod, dwUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "CN-001" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /Chưa được Recruiter nhập vào DW Data/);
  assert.equal(dwUpdates.length, 0, "KHÔNG được ghi Mã số công nhật khi chưa qua bước Nhập vào DW Data");
});

test("BLOCKER #1: dwImportedAt có giá trị -> submit thành công (idempotent, dwId khớp)", async () => {
  const apps = [
    { id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID },
  ];
  const { mod, dwUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "CN-001" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean }[];
  assert.equal(results[0].ok, true);
  assert.equal(dwUpdates.length, 1);
  assert.equal(dwUpdates[0].set.code, "CN-001");
});

test("Hồ sơ đã xoá mềm (deletedAt) -> bị từ chối kể cả khi dwId khớp và dwImportedAt có giá trị", async () => {
  const apps = [
    { id: APP_ID, deptId: "dept-A", deletedAt: new Date(), dwImportedAt: new Date(), dwId: DW_ID },
  ];
  const { mod, dwUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "CN-001" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /Không tìm thấy hồ sơ/);
  assert.equal(dwUpdates.length, 0);
});

test("dwId KHÔNG khớp -> bị từ chối (chống race condition / dữ liệu cũ trên client)", async () => {
  const apps = [
    { id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: "dw-khac" },
  ];
  const { mod, dwUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "CN-001" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /không khớp/);
  assert.equal(dwUpdates.length, 0);
});

test("Data Scope: hồ sơ ngoài phạm vi bị từ chối kể cả khi đã Nhập DW", async () => {
  const apps = [
    { id: APP_ID, deptId: "dept-OUTSIDE", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID },
  ];
  const { mod, dwUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: ["dept-A"], apps });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "CN-001" }] }));

  const results = res.body.results as { ok: boolean }[];
  assert.equal(results[0].ok, false);
  assert.equal(dwUpdates.length, 0);
});

/* ------------------------------------------------------------
   BLOCKER #3 — GET phải mặc định ẩn CCCD cho role không có privacy.view_cccd.
   ------------------------------------------------------------ */
test("BLOCKER #3: GET ẩn CCCD mặc định khi role không có privacy.view_cccd", async () => {
  const getRows = [
    { dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, startingDate: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", dailyCodeUpdatedAt: null, dailyCodeUpdatedBy: null },
  ];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, canViewCccd: false, scope: null, getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/administration/daily-code?date=2026-08-17"));

  assert.equal(res.status, 200);
  const rows = res.body.rows as { cccd: string }[];
  assert.equal(rows[0].cccd, "••••••••8901");
});

test("BLOCKER #3: GET trả CCCD đầy đủ khi role CÓ privacy.view_cccd", async () => {
  const getRows = [
    { dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, startingDate: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", dailyCodeUpdatedAt: null, dailyCodeUpdatedBy: null },
  ];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, canViewCccd: true, scope: null, getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/administration/daily-code?date=2026-08-17"));

  const rows = res.body.rows as { cccd: string }[];
  assert.equal(rows[0].cccd, "012345678901");
});
