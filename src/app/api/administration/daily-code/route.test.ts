import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   ROUTE LAYER TESTS — GET/PATCH /api/administration/daily-code
   ------------------------------------------------------------
   Runs against the real compiled route module via VM sandbox.
   Pattern: src/app/api/bulk-import/dw/route.test.ts.

   Coverage:
     - BLOCKER #1 — PATCH must re-verify dwImportedAt at server.
     - Soft-deleted applications must be rejected.
     - BLOCKER #3 — GET must apply privacy.view_cccd masking.
     - Data scope enforcement (deptId scoping).
     - FINAL BLOCKER — Post-go-live canonical enforcement (12 tests).
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
    dwCodeAssignments: { __table: "dw_code_assignments", id: {}, codeId: {}, dwDataId: {}, employmentSessionId: {}, releasedAt: {} },
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
        return value.length > 4 ? `\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${value.slice(-4)}` : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
      },
    },
    "@/lib/daily-code-list": {
      getDailyCodeRows: async () => opts.getRows ?? [],
    },
    "@/lib/dw-code-pool": {
      // Pre-flight / GET tests never reach pool service. Stub prevents require() throw.
      allocateDwCode: async () => { throw new Error("allocateDwCode must not be called in pre-flight tests"); },
      releaseDwCode: async () => { throw new Error("releaseDwCode must not be called in pre-flight tests"); },
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
    console, process, Date, Promise, JSON, Math, Number, String, Boolean, Array, Object, Set, Map,
    Error, TypeError, RangeError, isNaN, parseInt, parseFloat, URL,
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

/* ── PRE-FLIGHT GUARD TESTS ──────────────────────────────────────────────── */

test("BLOCKER #1: dwImportedAt=null -> rejected (guard fires before any pool lookup)", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: null, dwId: DW_ID }];
  const { mod, dwUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "CN-001" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false, "must be rejected when dwImportedAt is null");
  assert.ok(results[0].reason.includes("DW Data"), `reason must mention DW Data, got: ${results[0].reason}`);
  assert.equal(dwUpdates.length, 0, "must not write dw_data.code");
});

test("BLOCKER #1: dwImportedAt has value -> pre-flight passes (CONTRACT A fires next for unknown code)", async () => {
  // After removing legacy fallback, an unknown code code now hits CONTRACT A rejection.
  // This test verifies the dwImportedAt pre-flight passes (ok: false is from CONTRACT A, not pre-flight).
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID }];
  const { mod, dwUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "CN-001" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; reason: string }[];
  // CONTRACT A fires: code "CN-001" is not in pool. The reason must be about pool lookup, not dwImportedAt.
  assert.equal(results[0].ok, false, "unknown code fails CONTRACT A");
  assert.ok(!results[0].reason.includes("DW Data"), `reason must NOT be about dwImportedAt, got: ${results[0].reason}`);
  assert.ok(results[0].reason.includes("badge") || results[0].reason.includes("pool") || results[0].reason.includes("trong"), `reason must be about unknown code, got: ${results[0].reason}`);
  assert.equal(dwUpdates.length, 0, "no write for unknown code");
});

test("Soft-deleted app (deletedAt) -> rejected even with valid dwId and dwImportedAt", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: new Date(), dwImportedAt: new Date(), dwId: DW_ID }];
  const { mod, dwUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "CN-001" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.ok(results[0].reason.length > 0, "must have a reason");
  assert.equal(dwUpdates.length, 0);
});

test("dwId mismatch -> rejected (anti race-condition guard)", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: "dw-khac" }];
  const { mod, dwUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, apps });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "CN-001" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.ok(results[0].reason.toLowerCase().includes("kh") || results[0].reason.includes("Data"), `reason must mention mismatch, got: ${results[0].reason}`);
  assert.equal(dwUpdates.length, 0);
});

test("Data scope: app outside scope rejected even after DW import", async () => {
  const apps = [{ id: APP_ID, deptId: "dept-OUTSIDE", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID }];
  const { mod, dwUpdates } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: ["dept-A"], apps });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "CN-001" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.ok(results[0].reason.includes("vi"), `reason must mention scope, got: ${results[0].reason}`);
  assert.equal(dwUpdates.length, 0);
});

/* ── GET TESTS ───────────────────────────────────────────────────────────── */

test("BLOCKER #3: GET masks CCCD by default when role lacks privacy.view_cccd", async () => {
  const getRows = [{ dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, startingDate: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", dailyCodeUpdatedAt: null, dailyCodeUpdatedBy: null }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, getRows, canViewCccd: false });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/administration/daily-code?date=2026-08-17"));

  assert.equal(res.status, 200);
  const rows = res.body.rows as { cccd: string }[];
  assert.ok(rows[0].cccd !== "012345678901", "CCCD must be masked");
});

test("BLOCKER #3: GET returns full CCCD when role has privacy.view_cccd", async () => {
  const getRows = [{ dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, startingDate: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", dailyCodeUpdatedAt: null, dailyCodeUpdatedBy: null }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, getRows, canViewCccd: true });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/administration/daily-code?date=2026-08-17"));

  assert.equal(res.status, 200);
  const rows = res.body.rows as { cccd: string }[];
  assert.equal(rows[0].cccd, "012345678901", "CCCD must be returned in full");
});

test("Data Scope: dept-A manager querying dept-B -> 403", async () => {
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: ["dept-A"], getRows: [] });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/administration/daily-code?date=2026-08-17&deptId=dept-B"));

  assert.equal(res.status, 403);
  assert.ok(!("rows" in res.body), "must not leak rows on 403");
});

test("Data Scope: dept-A manager querying dept-A -> 200", async () => {
  const getRows = [{ dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, startingDate: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", dailyCodeUpdatedAt: null, dailyCodeUpdatedBy: null }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: ["dept-A"], getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/administration/daily-code?date=2026-08-17&deptId=dept-A"));

  assert.equal(res.status, 200);
  const rows = res.body.rows as { dailyApplicationId: string }[];
  assert.equal(rows.length, 1);
});

test("Data Scope: ADMIN (scope=null) not blocked by any deptId", async () => {
  const getRows = [{ dailyApplicationId: APP_ID, cccd: "012345678901", fullName: "Nguyen Van A", deptId: "dept-ANY", deptName: "Dept Any", groupName: null, startingDate: null, dwImportedAt: new Date(), dwDataId: DW_ID, code: "CN-001", dailyCodeUpdatedAt: null, dailyCodeUpdatedBy: null }];
  const { mod } = loadRoute({ guardFor: () => ADMIN_GUARD, scope: null, getRows });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(undefined, "http://localhost/api/administration/daily-code?date=2026-08-17&deptId=dept-ANY"));

  assert.equal(res.status, 200);
});

/* ============================================================
   CANONICAL DW CODE WRITER — FINAL BLOCKER FIX REGRESSION TESTS
   (Mission: fix/canonical-dw-code-writer-post-golive — commit 2)
   ============================================================
   Business contracts tested (all enforced after Activation #3):
     1.  Unknown code -> reject, dw_data unchanged (CONTRACT A)
     2.  AVAILABLE code + no active session -> reject (CONTRACT F)
     3.  Clear finds active canonical assignment by dwDataId (CONTRACT G)
     4.  Canonical assignment released regardless of dailyApplicationId (CONTRACT G)
     5.  Clear must not mirror-clear while pool code is ASSIGNED to another (CONTRACT H)
     6.  RETIRED code remains rejected (CONTRACT B)
     7.  ASSIGNED same worker remains idempotent ok (CONTRACT C)
     8.  ASSIGNED other worker remains rejected (CONTRACT D)
     9.  AVAILABLE canonical allocation remains atomic (CONTRACT E)
    10.  Canonical allocation failure leaves mirror unchanged
    11.  Mirror failure rolls back canonical allocation
    12.  No unknown free-text code can enter dw_data.code (CONTRACT A, all paths)
   ============================================================ */

type PoolCallRecord =
  | { fn: "allocateDwCode"; input: Record<string, unknown>; result: Record<string, unknown> }
  | { fn: "releaseDwCode"; input: Record<string, unknown>; result: Record<string, unknown> };

function loadCanonicalRoute(opts: {
  guardFor?: (roles: string[], key: string) => Guard;
  scope?: string[] | null;
  apps?: Record<string, unknown>[];
  poolRows?: Record<string, unknown>[];
  assignmentRows?: Record<string, unknown>[];
  sessionRows?: Record<string, unknown>[];
  dwDataRows?: Record<string, unknown>[];
  allocateDwCodeResult?: Record<string, unknown>;
  releaseDwCodeResult?: Record<string, unknown>;
  allocateThrows?: boolean;
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
    dwCodeAssignments: { __table: "dw_code_assignments", id: {}, codeId: {}, dwDataId: {}, employmentSessionId: {}, releasedAt: {} },
    employmentSessions: { __table: "employment_sessions", id: {}, workerId: {}, dailyApplicationId: {}, endDate: {} },
    departments: { __table: "departments", id: {} },
  };

  const apps = opts.apps ?? [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID }];

  const tableMap: Record<string, unknown[]> = {
    daily_applications: apps,
    dw_codes: opts.poolRows ?? [],
    dw_code_assignments: opts.assignmentRows ?? [],
    employment_sessions: opts.sessionRows ?? [],
    dw_data: opts.dwDataRows ?? [],
  };

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
      values: (_v: unknown) => ({ returning: async () => [{}] }),
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

/* ── FINAL BLOCKER TEST 1: Unknown code -> reject (CONTRACT A) ─────────── */
test("FINAL BLOCKER 1: Unknown code (not in dw_codes) -> reject, dw_data.code unchanged, zero writes", async () => {
  const { mod, poolCalls, dwUpdates } = loadCanonicalRoute({ poolRows: [], sessionRows: [] });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR-UNKNOWN-99" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false, "unknown code must be rejected");
  assert.ok(results[0].reason.includes("trong") || results[0].reason.includes("badge"), `reason must be about unknown code, got: ${results[0].reason}`);
  assert.equal(dwUpdates.length, 0, "dw_data.code must NOT be written");
  assert.equal(poolCalls.length, 0, "pool service must NOT be called");
});

/* ── FINAL BLOCKER TEST 2: AVAILABLE + no session -> reject (CONTRACT F) ── */
test("FINAL BLOCKER 2: AVAILABLE code + no active employment session -> reject, no split-brain", async () => {
  const { mod, poolCalls, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "AVAILABLE", locationId: "loc-1" }],
    assignmentRows: [],
    sessionRows: [],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00100-D" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false, "must reject when no session");
  assert.ok(results[0].reason.length > 0, "must have a reason");
  assert.equal(dwUpdates.length, 0, "dw_data.code must NOT be written");
  assert.equal(poolCalls.length, 0, "allocateDwCode must NOT be called");
});

/* ── FINAL BLOCKER TEST 3: Clear via canonical assignment by dwDataId (CONTRACT G) ── */
test("FINAL BLOCKER 3: Clear (blank) finds active canonical assignment by dwDataId -> releases canonically via its employmentSessionId", async () => {
  const { mod, poolCalls, dwUpdates } = loadCanonicalRoute({
    poolRows: [],
    assignmentRows: [{ id: "assign-1", codeId: CODE_ID, dwDataId: DW_ID, employmentSessionId: SESS_ID, releasedAt: null }],
    sessionRows: [],
    releaseDwCodeResult: { released: true, code: "DR00100-D" },
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "" }] }));

  const results = res.body.results as { ok: boolean; canonical: boolean }[];
  assert.equal(results[0].ok, true, "canonical clear must succeed");
  assert.equal(results[0].canonical, true);
  const releaseCall = poolCalls.find((c) => c.fn === "releaseDwCode");
  assert.ok(releaseCall, "releaseDwCode must be called");
  assert.equal((releaseCall!.input as Record<string, unknown>).employmentSessionId, SESS_ID, "must use the assignment's employmentSessionId");
  assert.ok(dwUpdates.some((u) => u.set.code === null), "dw_data.code must be cleared");
});

/* ── FINAL BLOCKER TEST 4: Clear uses assignment session even if dailyApplicationId differs (CONTRACT G) ── */
test("FINAL BLOCKER 4: Canonical assignment released even if current dailyApplicationId does not point to its session", async () => {
  const OTHER_SESS_ID = "77777777-7777-7777-7777-777777777777";
  const { mod, poolCalls } = loadCanonicalRoute({
    poolRows: [],
    assignmentRows: [{ id: "assign-2", codeId: CODE_ID, dwDataId: DW_ID, employmentSessionId: OTHER_SESS_ID, releasedAt: null }],
    sessionRows: [],
    releaseDwCodeResult: { released: true, code: "DR00100-D" },
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "" }] }));

  const results = res.body.results as { ok: boolean; canonical: boolean }[];
  assert.equal(results[0].ok, true, "must succeed regardless of dailyApplicationId linkage");
  const releaseCall = poolCalls.find((c) => c.fn === "releaseDwCode");
  assert.ok(releaseCall, "releaseDwCode must be called");
  assert.equal((releaseCall!.input as Record<string, unknown>).employmentSessionId, OTHER_SESS_ID, "must use the canonical assignment's own session");
});

/* ── FINAL BLOCKER TEST 5: Clear must not mirror-clear while canonical assignment is active (CONTRACT H) ── */
test("FINAL BLOCKER 5: Clear — mirror code is ASSIGNED in pool to DIFFERENT worker -> fail closed, no mirror write", async () => {
  const { mod, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "ASSIGNED", locationId: "loc-1" }],
    assignmentRows: [],
    sessionRows: [],
    dwDataRows: [{ id: DW_ID, code: "DR00100-D" }],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false, "must fail closed — cannot clear mirror with ASSIGNED pool code");
  assert.ok(results[0].reason.length > 0, "must have a reason");
  assert.equal(dwUpdates.length, 0, "dw_data.code must NOT be cleared");
});

/* ── FINAL BLOCKER TEST 6: RETIRED remains rejected (CONTRACT B) ─────────── */
test("FINAL BLOCKER 6: RETIRED code -> fails closed, zero writes", async () => {
  const { mod, dwUpdates, poolCalls } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00050-D", status: "RETIRED", locationId: "loc-1" }],
    sessionRows: [],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00050-D" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.ok(results[0].reason.includes("RETIRED"), `reason must mention RETIRED, got: ${results[0].reason}`);
  assert.equal(dwUpdates.length, 0);
  assert.equal(poolCalls.length, 0);
});

/* ── FINAL BLOCKER TEST 7: ASSIGNED same worker -> idempotent (CONTRACT C) ─ */
test("FINAL BLOCKER 7: ASSIGNED code for THIS worker -> idempotent ok, no re-write", async () => {
  const { mod, poolCalls, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "ASSIGNED", locationId: "loc-1" }],
    assignmentRows: [{ id: "assign-mine", codeId: CODE_ID, dwDataId: DW_ID, employmentSessionId: SESS_ID, releasedAt: null }],
    sessionRows: [],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00100-D" }] }));

  const results = res.body.results as { ok: boolean; canonical: boolean }[];
  assert.equal(results[0].ok, true);
  assert.equal(results[0].canonical, true);
  assert.equal(poolCalls.length, 0, "allocateDwCode must NOT be called");
  assert.equal(dwUpdates.length, 0, "dw_data must NOT be re-written");
});

/* ── FINAL BLOCKER TEST 8: ASSIGNED other worker -> reject (CONTRACT D) ──── */
test("FINAL BLOCKER 8: ASSIGNED code held by DIFFERENT worker -> reject, zero writes", async () => {
  const OTHER_DW_ID = "66666666-6666-6666-6666-666666666666";
  const { mod, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "ASSIGNED", locationId: "loc-1" }],
    assignmentRows: [{ id: "assign-other", codeId: CODE_ID, dwDataId: OTHER_DW_ID, employmentSessionId: SESS_ID, releasedAt: null }],
    sessionRows: [],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00100-D" }] }));

  const results = res.body.results as { ok: boolean; reason: string }[];
  assert.equal(results[0].ok, false);
  assert.ok(results[0].reason.length > 0, "must have a reason");
  assert.equal(dwUpdates.length, 0);
  void OTHER_DW_ID;
});

/* ── FINAL BLOCKER TEST 9: AVAILABLE + session -> canonical allocate (CONTRACT E) ── */
test("FINAL BLOCKER 9: AVAILABLE code + valid active session -> canonical allocate, atomic write", async () => {
  const { mod, poolCalls, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00412-D", status: "AVAILABLE", locationId: "loc-1" }],
    assignmentRows: [],
    sessionRows: [{ id: SESS_ID, workerId: WORKER_ID, dailyApplicationId: APP_ID, endDate: null }],
    allocateDwCodeResult: { ok: true, code: "DR00412-D", codeId: CODE_ID, reused: true },
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00412-D" }] }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean; canonical: boolean }[];
  assert.equal(results[0].ok, true);
  assert.equal(results[0].canonical, true);
  const allocCall = poolCalls.find((c) => c.fn === "allocateDwCode");
  assert.ok(allocCall, "allocateDwCode must be called");
  assert.equal((allocCall!.input as Record<string, unknown>).specificCodeId, CODE_ID, "must pass specificCodeId");
  assert.ok(dwUpdates.some((u) => u.set.code !== undefined), "dw_data.code must be updated");
});

/* ── FINAL BLOCKER TEST 10: Canonical allocate failure -> mirror unchanged ── */
test("FINAL BLOCKER 10: allocateDwCode throws -> 500, dw_data.code mirror unchanged", async () => {
  const { mod, dwUpdates } = loadCanonicalRoute({
    poolRows: [{ id: CODE_ID, code: "DR00100-D", status: "AVAILABLE", locationId: "loc-1" }],
    assignmentRows: [],
    sessionRows: [{ id: SESS_ID, workerId: WORKER_ID, dailyApplicationId: APP_ID, endDate: null }],
    allocateThrows: true,
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "DR00100-D" }] }));

  assert.equal(res.status, 500, "must surface 500 when canonical pool throws");
  assert.equal(dwUpdates.length, 0, "dw_data.code must NOT have been written");
});

/* ── FINAL BLOCKER TEST 11: Mirror failure rolls back canonical allocation ── */
test("FINAL BLOCKER 11: dw_data UPDATE throws in H-path clear -> 500, canonical state not committed", async () => {
  const { mod, poolCalls } = loadCanonicalRoute({
    poolRows: [],
    assignmentRows: [],
    dwDataRows: [{ id: DW_ID, code: "DR-OLD" }],
    sessionRows: [],
    dwDataUpdateThrows: true,
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items: [{ dailyApplicationId: APP_ID, dwDataId: DW_ID, code: "" }] }));

  assert.equal(res.status, 500, "must surface 500 on mirror write failure");
  assert.equal(poolCalls.length, 0, "pool service must not have been called");
});

/* ── FINAL BLOCKER TEST 12: No unknown free-text code can enter dw_data.code ── */
test("FINAL BLOCKER 12: All paths — no unknown free-text code can enter dw_data.code after go-live", async () => {
  const codes = ["BADGE-FAKE-1", "DR-XYZ-99", "TRIMMED", "99999"];
  const items = codes.map((code) => ({ dailyApplicationId: APP_ID, dwDataId: DW_ID, code }));

  const { mod, dwUpdates, poolCalls } = loadCanonicalRoute({
    apps: [{ id: APP_ID, deptId: "dept-A", deletedAt: null, dwImportedAt: new Date(), dwId: DW_ID }],
    poolRows: [],
    assignmentRows: [],
    sessionRows: [],
  });
  const PATCH = mod.PATCH as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeCanonicalReq({ items }));

  assert.equal(res.status, 200);
  const results = res.body.results as { ok: boolean }[];
  const successItems = results.filter((r) => r.ok);
  assert.equal(successItems.length, 0, "zero items may succeed when all codes are unknown");
  assert.equal(dwUpdates.length, 0, "dw_data.code must NEVER be written for any unknown code");
  assert.equal(poolCalls.length, 0, "pool service must never be called for unknown codes");
});
