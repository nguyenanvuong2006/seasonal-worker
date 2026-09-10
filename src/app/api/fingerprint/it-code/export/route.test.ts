import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET /api/fingerprint/it-code/export
   ------------------------------------------------------------
   Theo đúng mẫu src/app/api/meal/export/route.test.ts:
     • deptId ngoài Data Scope -> 403, KHÔNG gọi
       getFingerprintItCodeRows, KHÔNG xuất file.
     • deptId + q + filter hợp lệ được truyền ĐÚNG xuống
       getFingerprintItCodeRows — ĐÚNG hàm dùng chung với GET
       /api/fingerprint/it-code (list) — file xuất luôn khớp danh
       sách đang hiển thị.
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
    "@/lib/fingerprint-it-code-list": {
      getFingerprintItCodeRows: async (date: string, scope: string[] | null, filters: Record<string, unknown>) => {
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
    "@/lib/daily-operations-export": {
      buildDailyOperationsWorkbook: async () => Buffer.from("fake-xlsx"),
      exportFilenameHeaders: (baseName: string, date: string) => ({
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${baseName}-${date}.xlsx"`,
      }),
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
    Uint8Array,
  });
  vm.runInContext(js, context);

  return { mod: moduleObj.exports, calls, audits };
}

function makeReq(url: string) {
  return { url } as unknown as Request;
}

test("deptId ngoài Data Scope -> 403, KHÔNG gọi getFingerprintItCodeRows, KHÔNG xuất file", async () => {
  const { mod, calls } = loadRoute({ scope: ["dept-A"] });
  const GET = mod.GET as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq("http://localhost/api/fingerprint/it-code/export?date=2026-08-17&deptId=dept-OUTSIDE"));

  assert.equal(res.status, 403);
  assert.equal(calls.length, 0, "fail-closed: không được truy vấn/xuất dữ liệu ngoài Data Scope");
});

test("deptId + q + filter hợp lệ được truyền đúng xuống getFingerprintItCodeRows — CÙNG hàm với GET /api/fingerprint/it-code", async () => {
  const { mod, calls, audits } = loadRoute({
    scope: ["dept-A", "dept-B"],
    rows: [{ dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", deptId: "dept-A", deptName: "Dept A", groupName: null, code: "CN-001", itCode: "IT-001" }],
  });
  const GET = mod.GET as (req: Request) => Promise<{ status: number }>;
  const res = await GET(makeReq("http://localhost/api/fingerprint/it-code/export?date=2026-08-17&deptId=dept-A&q=Nguyen&filter=DONE"));

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].date, "2026-08-17");
  assert.equal(calls[0].filters.deptId, "dept-A");
  assert.equal(calls[0].filters.q, "Nguyen");
  assert.equal(calls[0].filters.status, "DONE", "route param tên là 'filter' nhưng phải truyền vào getFingerprintItCodeRows như filters.status");
  assert.equal(audits.length, 1, "phải audit mỗi lần export");
  assert.equal(audits[0].detail.deptId, "dept-A");
  assert.equal(audits[0].detail.filter, "DONE");
});

test("filter mặc định là ALL khi không truyền trên query string", async () => {
  const { mod, calls } = loadRoute({ scope: null });
  const GET = mod.GET as (req: Request) => Promise<{ status: number }>;
  await GET(makeReq("http://localhost/api/fingerprint/it-code/export?date=2026-08-17"));

  assert.equal(calls[0].filters.status, "ALL");
});
