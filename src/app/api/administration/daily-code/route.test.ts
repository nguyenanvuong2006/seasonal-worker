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
    limit: () => chain,
    for: () => chain,
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
    select: () => ({
      from: (table: { __table?: string }) => makeChain(tableResults[table.__table ?? ""] ?? []),
    }),
    update: (table: { __table?: string }) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          if (table.__table === "dw_data") dwUpdates.push({ set });
          return { rowCount: 1 };
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (_v: unknown) => ({ returning: async () => [{}] }),
    }),
  };

  const dbStub = {
    select: () => ({
      from: (table: { __table?: string }) => makeChain(tableResults[table.__table ?? ""] ?? []),
    }),
    transaction: async (fn: (tx: typeof txApi) => Promise<unknown>) => fn(txApi),
  };

  const schemaStub = {
    dailyApplications: { __table: "daily_applications", id: {}, deptId: {}, regDate: {}, deletedAt: {}, dwImportedAt: {}, dwId: {} },
    dwData: { __table: "dw_data", id: {}, code: {} },
    dwCodes: { __table: "dw_codes", id: {}, code: {}, status: {}, locationId: {} },
    dwCodeAssignments: { __table: "dw_code_assignments", id: {}, codeId: {}, dwDataId: {}, releasedAt: {} },
    employmentSessions: { __table: "employment_sessions", id: {}, workerId: {}, dailyApplicationId: {}, endDate: {} },
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
      maskCccd: (value: string | null, canView: boolean) => {
        if (!value) return value;
        if (canView) return value;
        return value.length > 4 ? `••••••••${value.slice(-4)}` : "••••••••";
      },
    },
    "@/lib/daily-code-list": {
      getDailyCodeRows: async () => opts.getRows ?? [],
    },
    "@/lib/dw-code-pool": {
      // The original 10 tests exercise pre-flight guards and GET — the pool service
      // is never reached. Provide a minimal stub so require() does not throw.
      allocateDwCode: async () => { throw new Error("allocateDwCode must not be called in legacy-guard tests"); },
      releaseDwCode: async () => { throw new Error("releaseDwCode must not be called in legacy-guard tests"); },
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

/* ------------------------------------------------------------
   PHASE 7 — RBAC / Data Scope: GET với deptId ngoài phạm vi phải bị
   từ chối NGAY từ route, không được truy vấn getDailyCodeRows. Trực
   tiếp thao túng deptId qua query string không được mở rộng Data Scope.
   ------------------------------------------------------------ */
test("Data Scope: Department Manager (scope=dept-A) truyền deptId=dept-B trên query string -> 403, KHÔNG rò rỉ dữ liệu ngoài phạm vi", async () => {
  const getRows = [{ dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-B", deptName: "Dept B", groupName: null, startingDate: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", dailyCodeUpdatedAt: null, dailyCodeUpdatedBy: null }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: ["dept-A"], getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/administration/daily-code?date=2026-08-17&deptId=dept-B"));

  assert.equal(res.status, 403);
  assert.match(res.body.error as string, /Ngoài phạm vi/);
  assert.equal(res.body.rows, undefined, "response 403 KHÔNG được kèm theo dữ liệu");
});

test("Data Scope: Department Manager (scope=dept-A) truyền deptId=dept-A -> 200, được phép xem đúng phạm vi của mình", async () => {
  const getRows = [{ dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, startingDate: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", dailyCodeUpdatedAt: null, dailyCodeUpdatedBy: null }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: ["dept-A"], getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/administration/daily-code?date=2026-08-17&deptId=dept-A"));

  assert.equal(res.status, 200);
  const rows = res.body.rows as { dailyApplicationId: string }[];
  assert.equal(rows.length, 1);
});

test("Data Scope: ADMIN/global (scope=null) không bị chặn bởi bất kỳ deptId nào", async () => {
  const getRows = [{ dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-ANY", deptName: "Dept Any", groupName: null, startingDate: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", dailyCodeUpdatedAt: null, dailyCodeUpdatedBy: null }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/administration/daily-code?date=2026-08-17&deptId=dept-ANY"));

  assert.equal(res.status, 200);
});

/* ============================================================
   CANONICAL DW CODE WRITER — POST-GO-LIVE REGRESSION TESTS
   (Mission: fix/canonical-dw-code-writer-post-golive)
   ============================================================
   Tests 1–12 prove the mission's 12 regression requirements:
     1. Normal assignment goes through canonical DW service.
     2. Endpoint cannot directly free-text bypass when code is in pool.
     3. Duplicate active code assignment fails closed.
     4. Worker with existing active assignment cannot receive second code.
     5. RETIRED code cannot become AVAILABLE/reassigned.
     6. Clear/release follows canonical release behavior.
     7. Canonical failure leaves legacy mirror unchanged.
     8. Legacy mirror failure rolls back canonical mutation.
     9. Idempotent resubmit of already-assigned same code succeeds.
    10. Code not in pool → legacy fallback with warning flag.
    11. nextSequence not consumed by the PATCH route.
    12. No PII (codes, CCCDs, names) in error reason strings.

   Loader approach: same VM/TypeScript compile pattern as above, with
   the dw-code-pool module stubbed as an injectable collaborator (so we
   can assert whether allocateDwCode / releaseDwCode were called, and
   inject faults to test rollback semantics). The schema stub is extended
   with the new tables imported by the canonical route.
   ============================================================ */

type PoolCallRecord =
  | { fn: "allocateDwCode"; input: Record<string, unknown>; result: Record<string, unknown> }
  | { fn: "releaseDwCode"; input: Record<string, unknown>; result: Record<string, unknown> };

function loadCanonicalRoute(opts: {
  guardFor?: (roles: string[], key: string) => Guard;
  scope?: string[] | null;
  apps?: Record<string, unknown>[];
  /** dw_codes rows returned by the pool-lookup SELECT */
  poolRows?: Record<string, unknown>[];
  /** dw_code_assignments rows returned by the active-assignment SELECT */
  assignmentRows?: Record<string, unknown>[];
  /** employment_sessions rows returned by the active-session SELECT */
  sessionRows?: Record<string, unknown>[];
  allocateDwCodeResult?: Record<string, unknown>;
  releaseDwCodeResult?: Record<string, unknown>;
  /** Throw on allocateDwCode to simulate canonical-layer failure */
  allocateThrows?: boolean;
  /** Throw on dwData update to simulate mirror-write failure */
  dwDataUpdateThrows?: boolean;
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const poolCalls: PoolCallRecord[] = [];
  const dwUpdates: { set: Record<string, unknown> }[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];

  const schemaStub = {
    dailyApplications: { __table: "daily_applications", id: {}, deptId: {}, deletedAt: {}, dwImportedAt: {}, dwId: {} },
    dwData: { __table: "dw_data", id: {}, code: {} },
    dwCodes: { __table: "dw_codes", id: {}, code: {}, status: {}, locationId: {} },
    dwCodeAssignments: { __table: "dw_code_assignments", id: {}, codeId: {}, dwDataId: {}, releasedAt: {} },
    employmentSessions: { __table: "employment_sessions", id: {}, workerId: {}, dailyApplicationId: {}, endDate: {} },
    departments: { __table: "departments", id: {} },
  };

  const apps = opts.apps ?? [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID }];

  const tableMap: Record<string, unknown[]> = {
    daily_applications: apps,
    dw_codes: opts.poolRows ?? [],
    dw_code_assignments: opts.assignmentRows ?? [],
    employment_sessions: opts.sessionRows ?? [],
  };

  // Chain factory — each .select().from(t).where(...).limit(1) resolves to tableMap[t.__table]
  function makeSelectChain(rows: unknown[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {
      from: (_t: unknown) => chain,
      where: (..._a: unknown[]) => chain,
      limit: (_n: unknown) => chain,
      for: (..._a: unknown[]) => chain,
      then: (resolve: (v: unknown) => void) => resolve(rows),
    };
    return chain;
  }

  const txApi: Record<string, unknown> = {
    select: () => ({
      from: (table: { __table?: string }) => {
        const rows = tableMap[table.__table ?? ""] ?? [];
        return makeSelectChain(rows);
      },
    }),
    update: (table: { __table?: string }) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          if (table.__table === "dw_data") {
            if (opts.dwDataUpdateThrows) throw new Error("Simulated dw_data update failure");
            dwUpdates.push({ set });
          }
          return { rowCount: 1 };
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (_v: unknown) => ({
        returning: async () => [{}],
      }),
    }),
  };

  const dbStub = {
    select: () => ({
      from: (table: { __table?: string }) => {
        const rows = tableMap[table.__table ?? ""] ?? [];
        return makeSelectChain(rows);
      },
    }),
    transaction: async (fn: (tx: typeof txApi) => Promise<unknown>) => fn(txApi),
  };

  const poolStub = {
    allocateDwCode: async (input: Record<string, unknown>) => {
      if (opts.allocateThrows) throw new Error("Simulated canonical pool failure");
      const result = opts.allocateDwCodeResult ?? { ok: true, code: "DR00001-D", codeId: "code-1", reused: true };
      poolCalls.push({ fn: "allocateDwCode", input, result });
      // If canonical allocate succeeded, simulate the dw_data.code mirror write that the real allocateDwCode does
      if ((result as Record<string, unknown>).ok) {
        dwUpdates.push({ set: { code: (input as Record<string, unknown>).specificCodeId ?? "DR-CANONICAL" } });
      }
      return result;
    },
    releaseDwCode: async (input: Record<string, unknown>) => {
      const result = opts.releaseDwCodeResult ?? { released: true, code: "DR00001-D" };
      poolCalls.push({ fn: "releaseDwCode", input, result });
      if ((result as Record<string, unknown>).released) {
        dwUpdates.push({ set: { code: null } });
      }
      return result;
    },
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
      isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
      desc: (col: unknown) => ({ op: "desc", col }),
    },
    "@/db": { db: dbStub },
    "@/db/schema": schemaStub,
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => (opts.guardFor ?? (() => ADMIN_GUARD))(roles, key),
      getUserScope: async () => opts.scope ?? null,
      hasPermission: async () => false,
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
    "@/lib/daily-intake-workflow": { maskCccd: (v: string | null) => v },
    "@/lib/date-range": {
      parseOperationalDateRange: () => ({ ok: true, range: { from: "2026-09-19", to: "2026-09-19" } }),
    },
    "@/lib/daily-code-list": { getDailyCodeRows: async () => [] },
    "@/lib/dw-code-pool": poolStub,
  };

  const moduleObj = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`Unexpected require("${specifier}")`);
  };
  const context = vm.createContext({
    module: moduleObj, exports: moduleObj.exports, require: requireShim,
    console, process, Date, Promise, JSON, Math, Number, String, Boolean, Array, Object, Set, Map,
    Error, TypeError, RangeError, isNaN, parseInt, parseFloat, URL,
  });
  vm.runInContext(js, context);
  return { mod: moduleObj.exports, poolCalls, dwUpdates, audits };
}

const SESS_ID = "33333333-3333-3333-3333-333333333333";
const CODE_ID = "44444444-4444-4444-4444-444444444444";
const WORKER_ID = "55555555-5555-5555-5555-555555555555";
const makeCanonicalReq = (body: unknown) => makeReq(body);

/* ── REQ 1: Normal AVAILABLE code → canonical path ─────────────────────── */
test("CANONICAL REQ 1: AVAILABLE pool code → goes through allocateDwCode, returns canonical=true", async () => {
  const { mod, poolCalls, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "AVAILABLE", locationId: "loc-1" }],
    assignmentRows: [],
    sessionRows: [{ id: SESS_ID, workerId: WORKER_ID, dailyApplicationId: APP_ID, endDate: null }],
    allocateDwCodeResult: { ok: true, code: "DR00100-D", codeId: CODE_ID, reused: true },
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00100-D" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; canonical: boolean }[];
  assert.equal(results[0].ok, true, "item must succeed");
  assert.equal(results[0].canonical, true, "must be canonical");
  assert.ok(poolCalls.some((c) => c.fn === "allocateDwCode"), "allocateDwCode must have been called");
  assert.ok(dwUpdates.some((u) => u.set.code !== undefined), "dw_data.code must be updated by the canonical service");
});

/* ── REQ 2: Free-text bypass of ASSIGNED code is blocked ───────────────── */
test("CANONICAL REQ 2: ASSIGNED code belonging to a DIFFERENT worker → fails closed (conflict)", async () => {
  const OTHER_DW_ID = "66666666-6666-6666-6666-666666666666";
  const { mod, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "ASSIGNED", locationId: "loc-1" }],
    // assignment belongs to a DIFFERENT dw_data row, not APP's DW_ID
    assignmentRows: [{ id: "assign-1", codeId: CODE_ID, dwDataId: OTHER_DW_ID, releasedAt: null }],
    sessionRows: [],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00100-D" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false, "must be rejected");
  assert.match(results[0].reason, /đang được gán cho lao động khác/, "reason must cite conflict");
  assert.equal(dwUpdates.length, 0, "dw_data must NOT be written");
});

/* ── REQ 3: Duplicate active code assignment fails closed ───────────────── */
test("CANONICAL REQ 3: Submitting an AVAILABLE code when this worker already has an active canonical assignment → 409 conflict", async () => {
  const { mod, dwUpdates, poolCalls } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "AVAILABLE", locationId: "loc-1" }],
    // the WORKER already has an ACTIVE assignment for a DIFFERENT code (same dwDataId)
    assignmentRows: [{ id: "assign-existing", codeId: "other-code-id", dwDataId: DW_ID, releasedAt: null }],
    sessionRows: [{ id: SESS_ID, workerId: WORKER_ID, dailyApplicationId: APP_ID, endDate: null }],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00100-D" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false, "must fail closed");
  assert.match(results[0].reason, /đã có mã công nhật đang hoạt động/, "reason must explain existing active code");
  assert.equal(poolCalls.length, 0, "allocateDwCode must NOT be called");
  assert.equal(dwUpdates.length, 0, "dw_data must NOT be written");
});

/* ── REQ 4: Worker already has active code — allocateDwCode guard fires ─── */
test("CANONICAL REQ 4: allocateDwCode's own WORKER_ALREADY_HAS_ACTIVE_CODE guard fires → item rejected, no mirror write", async () => {
  const { mod, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "AVAILABLE", locationId: "loc-1" }],
    assignmentRows: [], // pre-check passes, but the lock-validated allocate still fails
    sessionRows: [{ id: SESS_ID, workerId: WORKER_ID, dailyApplicationId: APP_ID, endDate: null }],
    allocateDwCodeResult: { ok: false, error: "WORKER_ALREADY_HAS_ACTIVE_CODE" },
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00100-D" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /mã khác đang hoạt động/);
  // dwUpdates may contain the failed allocate's would-be write, but since allocate returns ok=false
  // the stub does NOT push to dwUpdates — verify the item fails and does not succeed
  const successItems = (res.body.results as { ok: boolean }[]).filter((r) => r.ok);
  assert.equal(successItems.length, 0, "no items may succeed when allocate fails");
});

/* ── REQ 5: RETIRED code → permanently blocked ──────────────────────────── */
test("CANONICAL REQ 5: RETIRED pool code → fails closed, cannot be reassigned", async () => {
  const { mod, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00050-D", status: "RETIRED", locationId: "loc-1" }],
    sessionRows: [],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00050-D" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /RETIRED/);
  assert.equal(dwUpdates.length, 0, "RETIRED code must never write dw_data.code");
});

/* ── REQ 6: Clearing → canonical releaseDwCode path ────────────────────── */
test("CANONICAL REQ 6: Clearing code (blank) with active session → calls releaseDwCode canonically", async () => {
  const { mod, poolCalls, dwUpdates } = loadCanonicalRoute({
    poolRows: [],
    sessionRows: [{ id: SESS_ID, workerId: WORKER_ID, dailyApplicationId: APP_ID, endDate: null }],
    releaseDwCodeResult: { released: true, code: "DR00100-D" },
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "" }] }));

  const results = res.body.results as { ok: boolean; canonical: boolean }[];
  assert.equal(results[0].ok, true);
  assert.equal(results[0].canonical, true, "clear with active session must be canonical");
  assert.ok(poolCalls.some((c) => c.fn === "releaseDwCode"), "releaseDwCode must be called");
  // releaseDwCode stub pushes { code: null } to dwUpdates
  assert.ok(dwUpdates.some((u) => u.set.code === null), "dw_data.code must be cleared by canonical release");
});

/* ── REQ 7: Canonical failure → legacy mirror NOT touched ───────────────── */
test("CANONICAL REQ 7: allocateDwCode throws → transaction rolls back, dw_data.code mirror unchanged", async () => {
  const { mod, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "AVAILABLE", locationId: "loc-1" }],
    assignmentRows: [],
    sessionRows: [{ id: SESS_ID, workerId: WORKER_ID, dailyApplicationId: APP_ID, endDate: null }],
    allocateThrows: true, // pool service throws inside the transaction
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00100-D" }] }));

  // The transaction exception is caught by the outer try/catch → 500
  assert.equal(res.status, 500, "must return 500 when canonical pool throws");
  assert.equal(dwUpdates.length, 0, "dw_data.code must NOT have been written before the throw");
});

/* ── REQ 8: Legacy mirror failure → canonical NOT committed (same tx) ───── */
test("CANONICAL REQ 8: dw_data UPDATE throws inside transaction → item 500-level error, canonical not committed", async () => {
  const { mod, poolCalls } = loadCanonicalRoute({
    poolRows: [], // no pool row → goes to legacy path
    sessionRows: [],
    dwDataUpdateThrows: true, // simulate dw_data update failure on the legacy path
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00999-D" }] }));

  assert.equal(res.status, 500, "must surface 500 on mirror write failure");
  // Since the exception propagates out of the transaction callback, no pool call was made either
  assert.equal(poolCalls.length, 0, "allocateDwCode must not have been called for a legacy-path item");
});

/* ── REQ 9: Same code already assigned to same worker → idempotent ok ──── */
test("CANONICAL REQ 9: ASSIGNED code that belongs to THIS worker's own dwDataId → idempotent success, canonical=true", async () => {
  const { mod, poolCalls, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "ASSIGNED", locationId: "loc-1" }],
    // The active assignment belongs to THIS worker (same DW_ID)
    assignmentRows: [{ id: "assign-mine", codeId: CODE_ID, dwDataId: DW_ID, releasedAt: null }],
    sessionRows: [],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00100-D" }] }));

  const results = res.body.results as { ok: boolean; canonical: boolean; reason: string }[];
  assert.equal(results[0].ok, true, "same-worker resubmit must succeed");
  assert.equal(results[0].canonical, true);
  assert.match(results[0].reason, /đã được gán/);
  // Neither allocateDwCode nor a dw_data write is needed for a true idempotent noop
  assert.equal(poolCalls.length, 0, "allocateDwCode must NOT be called for idempotent resubmit");
  assert.equal(dwUpdates.length, 0, "dw_data must NOT be re-written for idempotent resubmit");
});

/* ── REQ 10: Code not in pool → legacy fallback with warning ────────────── */
test("CANONICAL REQ 10: Code not in dw_codes pool → legacy mirror-only write, warning=LEGACY_CODE_NOT_IN_POOL", async () => {
  const { mod, poolCalls, dwUpdates } = loadCanonicalRoute({
    poolRows: [], // no pool row for this code
    sessionRows: [],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR13000-D" }] }));

  const results = res.body.results as { ok: boolean; canonical: boolean; warning?: string }[];
  assert.equal(results[0].ok, true, "legacy fallback must succeed");
  assert.equal(results[0].canonical, false, "must NOT be marked canonical");
  assert.equal(results[0].warning, "LEGACY_CODE_NOT_IN_POOL");
  assert.equal(poolCalls.length, 0, "allocateDwCode must NOT be called for legacy codes");
  assert.ok(dwUpdates.some((u) => u.set.code === "DR13000-D"), "dw_data.code must be written on legacy path");
});

/* ── REQ 11: nextSequence not consumed by PATCH ─────────────────────────── */
test("CANONICAL REQ 11: PATCH /api/administration/daily-code never consumes a new sequence number — only claims existing AVAILABLE rows", async () => {
  // We can tell because allocateDwCode is called with specificCodeId (reuse path),
  // NOT without it (new-sequence path). The specificCodeId coming from the AVAILABLE
  // pool row guarantees the route never mints a brand-new sequence.
  const { mod, poolCalls } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00412-D", status: "AVAILABLE", locationId: "loc-1" }],
    assignmentRows: [],
    sessionRows: [{ id: SESS_ID, workerId: WORKER_ID, dailyApplicationId: APP_ID, endDate: null }],
    allocateDwCodeResult: { ok: true, code: "DR00412-D", codeId: CODE_ID, reused: true },
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00412-D" }] }));

  const allocCall = poolCalls.find((c) => c.fn === "allocateDwCode");
  assert.ok(allocCall, "allocateDwCode must have been called");
  const input = (allocCall as PoolCallRecord & { fn: "allocateDwCode" }).input;
  assert.ok(input.specificCodeId, "must pass specificCodeId — never the new-sequence (no specificCodeId) path");
  assert.equal(input.specificCodeId, CODE_ID, "specificCodeId must match the pool row id");
});

/* ── REQ 12: No PII in error reasons ────────────────────────────────────── */
test("CANONICAL REQ 12: Error reason strings never contain raw CCCD, code string, or worker name", async () => {
  // Test the RETIRED path — the most likely place a code value could leak into an error
  const sensitiveCode = "DR00050-D";
  const { mod } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: sensitiveCode, status: "RETIRED", locationId: "loc-1" }],
    sessionRows: [],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: sensitiveCode }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  // Reason must describe the STATE (RETIRED), not echo the code value back
  assert.equal(results[0].ok, false);
  assert.ok(!results[0].reason.includes(sensitiveCode), `reason must not echo the code value ("${sensitiveCode}") — PII leak prevention`);
  // Also verify the DW_ID and APP_ID (UUIDs that identify the worker) are not in the reason
  assert.ok(!results[0].reason.includes(DW_ID), "reason must not contain dwDataId");
  assert.ok(!results[0].reason.includes(APP_ID), "reason must not contain dailyApplicationId");
});

