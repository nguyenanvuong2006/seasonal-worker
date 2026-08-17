import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — POST /api/bulk-import/dw ("Nhập vào DW Data")
   ------------------------------------------------------------
   Chạy trên ĐÚNG route thật, theo khuôn mẫu
   src/app/api/recruitment-requests/import/route.test.ts.

   Bao phủ (mục IV, XVI):
     • CASE 13 — bấm 2 lần -> idempotent, không tạo dw_data trùng
     • CASE 14 — người DW cũ quay lại -> LINK, không INSERT mới
     • Data Scope chặn ở SERVER theo department_id
     • Chưa xếp việc (chưa APPROVED) -> bị SKIP, không nhập DW
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

function loadRoute(opts: {
  guardFor: (roles: string[], key: string) => Guard;
  scope: string[] | null;
  apps: Record<string, unknown>[];
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const dwInserts: Record<string, unknown>[] = [];
  const dwUpdates: { id: string; set: Record<string, unknown> }[] = [];
  const appUpdates: { id: string; set: Record<string, unknown> }[] = [];
  const workerProfileUpdates: { cccd: string; set: Record<string, unknown> }[] = [];

  // dw_data hiện có trong "DB" giả — keyed theo cccd, để mô phỏng onConflictDoUpdate.
  const dwByCccd = new Map<string, { id: string; cccd: string }>();
  let dwSeq = 0;

  const txApi = {
    select: () => ({
      from: () => ({
        where: async () => opts.apps,
      }),
    }),
    insert: (table: { __table?: string }) => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            const existing = dwByCccd.get(v.cccd as string);
            if (existing) return [{ id: existing.id }];
            dwSeq += 1;
            const id = `dw-new-${dwSeq}`;
            dwByCccd.set(v.cccd as string, { id, cccd: v.cccd as string });
            dwInserts.push(v);
            return [{ id }];
          },
        }),
      }),
    }),
    update: (table: { __table?: string }) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          if (table.__table === "dw_data") dwUpdates.push({ id: "?", set });
          else if (table.__table === "worker_profiles") workerProfileUpdates.push({ cccd: "?", set });
          else if (table.__table === "daily_applications") appUpdates.push({ id: "?", set });
          return { rowCount: 1 };
        },
      }),
    }),
  };

  const dbStub = {
    ...txApi,
    transaction: async (fn: (tx: typeof txApi) => Promise<unknown>) => fn(txApi),
  };

  const schemaStub = {
    dailyApplications: { __table: "daily_applications" },
    dwData: { __table: "dw_data", cccd: { __col: "dw_data.cccd" }, id: { __col: "dw_data.id" } },
    workerProfiles: { __table: "worker_profiles" },
  };

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: {
        json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
      },
    },
    "drizzle-orm": {
      and: (...c: unknown[]) => ({ op: "and", c }),
      eq: (col: unknown, v: unknown) => ({ op: "eq", col, v }),
      inArray: (col: unknown, v: unknown) => ({ op: "inArray", col, v }),
      isNull: (col: unknown) => ({ op: "isNull", col }),
      sql: Object.assign((strings: TemplateStringsArray, ...vals: unknown[]) => ({ op: "sql", strings, vals }), {
        raw: (s: string) => ({ op: "sqlRaw", s }),
      }),
    },
    "@/db": { db: dbStub },
    "@/db/schema": schemaStub,
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => opts.guardFor(roles, key),
      getUserScope: async () => opts.scope,
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
    "@/lib/daily-intake-workflow": {
      decideDwImportAction: (app: { status: string; dwImportedAt: unknown; dwId: string | null }) => {
        if (app.status !== "APPROVED") return { action: "SKIP_NOT_APPROVED", reason: "Chưa xếp việc." };
        if (app.dwImportedAt) return { action: "SKIP_ALREADY_IMPORTED", reason: "Đã nhập trước đó." };
        if (app.dwId) return { action: "LINK_EXISTING", dwId: app.dwId };
        return { action: "INSERT_NEW" };
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

  return { mod: moduleObj.exports, audits, dwInserts, dwUpdates, appUpdates, workerProfileUpdates, dwByCccd };
}

function makeReq(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };

test("CASE 13 — bấm Nhập DW 2 lần: lần 2 SKIP_ALREADY_IMPORTED, không insert dw_data trùng", async () => {
  const apps = [
    { id: "11111111-1111-1111-1111-111111111111", cccd: "010000000001", fullName: "Nguyen Van A", gender: "Nam", dob: null, phone: "090", permanentAddress: null, residentialAddress: null, deptId: "dept-A", status: "APPROVED", dwImportedAt: new Date(), dwId: "dw-old-1" },
  ];
  const { mod, dwInserts, appUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ ids: ["11111111-1111-1111-1111-111111111111"] }));

  assert.equal(res.status, 200);
  assert.equal((res.body.results as { ok: boolean }[])[0].ok, false);
  assert.equal(dwInserts.length, 0, "không được insert dw_data mới cho hồ sơ đã nhập rồi");
  assert.equal(appUpdates.length, 0, "không ghi lại dwImportedAt lần nữa");
});

test("CASE 14 — người DW cũ quay lại (đã có dwId): LINK_EXISTING, KHÔNG insert dw_data mới", async () => {
  const apps = [
    { id: "22222222-2222-2222-2222-222222222222", cccd: "010000000002", fullName: "Tran Thi B", gender: "Nữ", dob: null, phone: "091", permanentAddress: null, residentialAddress: null, deptId: "dept-A", status: "APPROVED", dwImportedAt: null, dwId: "dw-cu-999" },
  ];
  const { mod, dwInserts, appUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ ids: ["22222222-2222-2222-2222-222222222222"] }));

  assert.equal(res.status, 200);
  assert.equal(res.body.linked, 1);
  assert.equal(res.body.inserted, 0);
  assert.equal(dwInserts.length, 0, "người DW cũ không được insert bản ghi dw_data mới");
  assert.equal(appUpdates.length, 1, "vẫn ghi dwImportedAt để đánh dấu đã xử lý");
  const setPayload = appUpdates[0].set as { dwId?: string };
  assert.equal(setPayload.dwId, "dw-cu-999", "phải link đúng dwId cũ, không đổi sang bản ghi khác");
});

test("Người hoàn toàn mới (chưa có dwId): INSERT_NEW đúng 1 dòng dw_data", async () => {
  const apps = [
    { id: "33333333-3333-3333-3333-333333333333", cccd: "010000000003", fullName: "Le Van C", gender: "Nam", dob: null, phone: "092", permanentAddress: null, residentialAddress: null, deptId: "dept-A", status: "APPROVED", dwImportedAt: null, dwId: null },
  ];
  const { mod, dwInserts } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ ids: ["33333333-3333-3333-3333-333333333333"] }));

  assert.equal(res.status, 200);
  assert.equal(res.body.inserted, 1);
  assert.equal(dwInserts.length, 1);
  assert.equal(dwInserts[0].cccd, "010000000003");
});

test("Chưa xếp việc (status khác APPROVED) -> SKIP, không nhập DW", async () => {
  const apps = [
    { id: "44444444-4444-4444-4444-444444444444", cccd: "010000000004", fullName: "Pham Thi D", gender: "Nữ", dob: null, phone: "093", permanentAddress: null, residentialAddress: null, deptId: "dept-A", status: "PENDING", dwImportedAt: null, dwId: null },
  ];
  const { mod, dwInserts } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ ids: ["44444444-4444-4444-4444-444444444444"] }));

  assert.equal((res.body.results as { ok: boolean; reason: string }[])[0].ok, false);
  assert.match((res.body.results as { reason: string }[])[0].reason, /xếp việc/);
  assert.equal(dwInserts.length, 0);
});

/* ------------------------------------------------------------
   Data Scope — mục XI: server enforce, không chỉ UI filter.
   ------------------------------------------------------------ */
test("Data Scope: hồ sơ ngoài phạm vi bị loại — không nhập DW", async () => {
  const apps = [
    { id: "55555555-5555-5555-5555-555555555555", cccd: "010000000005", fullName: "Ngo Van E", gender: "Nam", dob: null, phone: "094", permanentAddress: null, residentialAddress: null, deptId: "dept-OUTSIDE", status: "APPROVED", dwImportedAt: null, dwId: null },
  ];
  const { mod, dwInserts } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: ["dept-A"], apps });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ ids: ["55555555-5555-5555-5555-555555555555"] }));

  assert.equal((res.body.results as { ok: boolean }[])[0].ok, false);
  assert.equal(dwInserts.length, 0, "KHÔNG được nhập DW cho hồ sơ ngoài Data Scope");
});

/* ------------------------------------------------------------
   Permission — mục X, XV, XVI CASE 9/10/11 (dạng route-level): route này
   PHẢI gọi requirePermission với đúng permission key dw.import_from_registration,
   không phải role check tự viết tay.
   ------------------------------------------------------------ */
test("Route gọi requirePermission([ADMIN, HR_RECRUITER], 'dw.import_from_registration') — từ chối role khác", async () => {
  let capturedRoles: string[] = [];
  let capturedKey = "";
  const apps: Record<string, unknown>[] = [];
  const { mod } = loadRoute({
    guardFor: (roles, key) => {
      capturedRoles = roles;
      capturedKey = key;
      return { ok: false, status: 403, error: "Từ chối truy cập! Quyền hạn không hợp lệ." };
    },
    scope: null,
    apps,
  });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ ids: ["66666666-6666-6666-6666-666666666666"] }));

  assert.equal(res.status, 403);
  assert.equal(capturedKey, "dw.import_from_registration");
  // So sánh nội dung thay vì deepEqual — mảng roles được tạo BÊN TRONG vm context
  // (realm khác với test file), deepStrictEqual có thể báo "not reference-equal"
  // dù nội dung giống hệt.
  assert.equal(capturedRoles.length, 2);
  assert.ok(capturedRoles.includes("ADMIN"));
  assert.ok(capturedRoles.includes("HR_RECRUITER"));
});
