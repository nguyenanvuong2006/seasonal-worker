import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET /api/meal/export
   ------------------------------------------------------------
   Bao phủ (review PR #60 — blocker #4):
     • deptId ngoài Data Scope -> 403, KHÔNG gọi getMealEligibleWorkers,
       KHÔNG xuất file.
     • deptId + q hợp lệ được truyền ĐÚNG xuống getMealEligibleWorkers —
       ĐÚNG hàm dùng chung với /api/meal (list) — file xuất luôn khớp
       danh sách đang hiển thị.
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

const nodeRequire = createRequire(import.meta.url);

function loadRoute(opts: {
  guardFor?: (roles: string[], key: string) => Guard;
  scope: string[] | null;
  rows?: Record<string, unknown>[];
  canViewCccd?: boolean;
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const calls: { date: string; scope: string[] | null; filters: Record<string, unknown> }[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: class {
        status: number;
        body: unknown;
        headers: Record<string, string>;
        constructor(body: unknown, init?: { headers?: Record<string, string> }) {
          this.body = body;
          this.status = 200;
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
      hasPermission: async (_role: string, key: string) => (key === "privacy.view_cccd" ? (opts.canViewCccd ?? false) : false),
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
    "@/lib/helpers": { todayStr: () => "2026-08-17" },
    "@/lib/person-name": { normalizePersonName: (s: string) => s },
    "@/lib/meal-list": {
      getMealEligibleWorkers: async (date: string, scope: string[] | null, filters: Record<string, unknown>) => {
        calls.push({ date, scope, filters });
        return opts.rows ?? [];
      },
    },
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
    return nodeRequire(specifier);
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
    Buffer,
  });
  vm.runInContext(js, context);

  return { mod: moduleObj.exports, calls, audits };
}

function makeReq(url: string) {
  return { url } as unknown as Request;
}

test("BLOCKER #4: deptId ngoài Data Scope -> 403, KHÔNG gọi getMealEligibleWorkers, KHÔNG xuất file", async () => {
  const { mod, calls } = loadRoute({ scope: ["dept-A"] });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/meal/export?date=2026-08-17&deptId=dept-OUTSIDE"));

  assert.equal(res.status, 403);
  assert.equal(calls.length, 0, "fail-closed: không được truy vấn/xuất dữ liệu ngoài Data Scope");
});

test("BLOCKER #4: deptId + q hợp lệ được truyền đúng xuống getMealEligibleWorkers — CÙNG hàm với /api/meal", async () => {
  const { mod, calls, audits } = loadRoute({
    scope: ["dept-A", "dept-B"],
    rows: [{ dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, startingDate: null, code: "CN-001" }],
  });
  const GET = mod.GET as (req: Request) => Promise<{ status: number }>;
  const res = await GET(makeReq("http://localhost/api/meal/export?date=2026-08-17&deptId=dept-A&q=Nguyen"));

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].date, "2026-08-17");
  assert.equal(calls[0].filters.deptId, "dept-A");
  assert.equal(calls[0].filters.q, "Nguyen");
  assert.equal(audits.length, 1, "phải audit mỗi lần export");
  assert.equal(audits[0].detail.deptId, "dept-A");
  assert.equal(audits[0].detail.q, "Nguyen");
});

/* ------------------------------------------------------------
   BLOCKER #4 — wiring-level proof: /api/meal (list) và /api/meal/export
   nhận CÙNG query string -> phải gọi getMealEligibleWorkers với ĐÚNG
   cùng (date, scope, deptId, q) -> danh sách hiển thị và file xuất
   LUÔN đại diện cùng 1 tập lao động.
   ------------------------------------------------------------ */
test("BLOCKER #4: cùng query string date+deptId+q -> /api/meal và /api/meal/export gọi getMealEligibleWorkers với ĐÚNG cùng tham số", async () => {
  const exportLoaded = loadRoute({ scope: ["dept-A", "dept-B"] });
  const listUrl = new URL("../route.ts", import.meta.url);
  const listSource = readFileSync(listUrl, "utf8");
  const listJs = ts.transpileModule(listSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const listCalls: { date: string; scope: string[] | null; filters: Record<string, unknown> }[] = [];
  const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };
  const listStubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/auth": {
      requirePermission: async () => ADMIN_GUARD,
      getUserScope: async () => ["dept-A", "dept-B"],
      hasPermission: async () => false,
    },
    "@/lib/data-scope": {
      scopeAllowsDepartment: (scope: string[] | null, deptId: string | null) => (scope === null ? true : !!deptId && scope.includes(deptId)),
    },
    "@/lib/helpers": { todayStr: () => "2026-08-17" },
    "@/lib/person-name": { normalizePersonName: (s: string) => s },
    "@/lib/meal-list": {
      getMealEligibleWorkers: async (date: string, scope: string[] | null, filters: Record<string, unknown>) => {
        listCalls.push({ date, scope, filters });
        return [];
      },
    },
    "@/lib/daily-intake-workflow": { maskCccd: (v: string | null) => v, maskPhone: (v: string | null) => v },
  };
  const listModuleObj = { exports: {} as Record<string, unknown> };
  const listContext = vm.createContext({
    module: listModuleObj,
    exports: listModuleObj.exports,
    require: (specifier: string) => (specifier in listStubs ? listStubs[specifier] : nodeRequire(specifier)),
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
    Buffer,
  });
  vm.runInContext(listJs, listContext);

  const query = "date=2026-08-17&deptId=dept-A&q=Nguyen";
  const GET_LIST = listModuleObj.exports.GET as (req: Request) => Promise<unknown>;
  const GET_EXPORT = exportLoaded.mod.GET as (req: Request) => Promise<unknown>;
  await GET_LIST(makeReq(`http://localhost/api/meal?${query}`));
  await GET_EXPORT(makeReq(`http://localhost/api/meal/export?${query}`));

  assert.equal(listCalls.length, 1);
  assert.equal(exportLoaded.calls.length, 1);
  assert.equal(listCalls[0].date, exportLoaded.calls[0].date);
  assert.deepEqual(listCalls[0].scope, exportLoaded.calls[0].scope);
  assert.equal(listCalls[0].filters.deptId, exportLoaded.calls[0].filters.deptId);
  assert.equal(listCalls[0].filters.q, exportLoaded.calls[0].filters.q);
});
