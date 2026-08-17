import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET /api/meal
   ------------------------------------------------------------
   Bao phủ (review PR #60 — blocker #4):
     • deptId ngoài Data Scope -> 403, KHÔNG gọi getMealEligibleWorkers.
     • deptId + q hợp lệ được truyền ĐÚNG xuống getMealEligibleWorkers —
       nguồn filter DUY NHẤT dùng chung với /api/meal/export.
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
  canViewPhone?: boolean;
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const calls: { date: string; scope: string[] | null; filters: Record<string, unknown> }[] = [];
  const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: {
        json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
      },
    },
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => (opts.guardFor ? opts.guardFor(roles, key) : ADMIN_GUARD),
      getUserScope: async () => opts.scope,
      hasPermission: async (_role: string, key: string) =>
        key === "privacy.view_cccd" ? (opts.canViewCccd ?? false) : key === "privacy.view_phone" ? (opts.canViewPhone ?? false) : false,
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
      maskPhone: (value: string | null, canView: boolean) => {
        if (!value) return value;
        if (canView) return value;
        return value.length > 3 ? `••••••••${value.slice(-3)}` : "••••••••";
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

  return { mod: moduleObj.exports, calls };
}

function makeReq(url: string) {
  return { url } as unknown as Request;
}

test("BLOCKER #4: deptId ngoài Data Scope -> 403, KHÔNG gọi getMealEligibleWorkers", async () => {
  const { mod, calls } = loadRoute({ scope: ["dept-A"] });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/meal?date=2026-08-17&deptId=dept-OUTSIDE"));

  assert.equal(res.status, 403);
  assert.equal(calls.length, 0, "fail-closed: không được truy vấn dữ liệu ngoài Data Scope");
});

test("BLOCKER #4: deptId + q hợp lệ được truyền đúng xuống getMealEligibleWorkers (nguồn dùng chung)", async () => {
  const { mod, calls } = loadRoute({ scope: ["dept-A", "dept-B"] });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/meal?date=2026-08-17&deptId=dept-A&q=Nguyen"));

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].date, "2026-08-17");
  assert.equal(calls[0].filters.deptId, "dept-A");
  assert.equal(calls[0].filters.q, "Nguyen");
});

test("Không truyền deptId/q -> filters là null, vẫn dùng chung hàm getMealEligibleWorkers", async () => {
  const { mod, calls } = loadRoute({ scope: null });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  await GET(makeReq("http://localhost/api/meal?date=2026-08-17"));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].filters.deptId, null);
  assert.equal(calls[0].filters.q, null);
});
