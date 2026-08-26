/**
 * DW Data API (GET /api/workers) — RBAC role-rename audit regression.
 *
 * Route-level proof that a capability denial (missing dw.view) and a Data
 * Scope denial (dw.view granted, but no accessible scope) are two DIFFERENT,
 * distinguishable outcomes — never the same generic "no permission" message —
 * and that a role passing requirePermission() is never re-blocked by DW
 * Data's own scope check unless it genuinely has a restricted, non-null,
 * non-global scope (Phase 4 of the RBAC role-rename audit).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type FakeDb, type QueryCall } from "../../../lib/test-support/fake-drizzle.ts";

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  dailyApplications: makeTable("daily_applications"),
  dwData: makeTable("dw_data"),
};

type Context = {
  GET: (req: Request) => Promise<{ status: number; body: string }>;
  db: FakeDb;
};

function makeContext(opts: { guardResult: { ok: true; session: { id: string; username: string; fullName: string; role: string; deptId: string | null } } | { ok: false; status: number; error: string }; scope: string[] | null }): Context {
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "dw_data") {
        // The route issues 2 selects against dw_data: a count({ total }) and
        // the actual rows. Distinguish by whether .select() was called with
        // a projection argument (the count) or bare (the rows).
        const selectOp = call.ops.find((o) => o.fn === "select");
        const isCount = Boolean(selectOp && selectOp.args.length > 0);
        return isCount ? [{ total: 0 }] : [];
      }
      return undefined;
    },
  });

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return {
            NextResponse: {
              json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body: JSON.stringify(body) }),
            },
          };
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/auth":
          return {
            requirePermission: async () => opts.guardResult,
            getUserScope: async () => opts.scope,
            writeAudit: async () => undefined,
          };
        case "@/lib/metadata":
          return { getFieldDefinitions: async () => [] };
        case "@/lib/person-name":
          return { normalizePersonName: (s: string) => s };
        case "@/lib/validators":
          return { CCCD_ERROR_MESSAGE: "CCCD không hợp lệ.", isValidCccd: () => true };
        default:
          throw new Error(`Unexpected require("${id}") — route must not depend on this module.`);
      }
    },
    process,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    console,
    Date,
    JSON,
    Array,
    Object,
    Number,
    Boolean,
    String,
    Set,
    Math,
    RegExp,
  });
  vm.runInContext(jsSource, context);
  return { GET: (moduleObj.exports as { GET: Context["GET"] }).GET, db };
}

test("RBAC role-rename: dw.view granted (requirePermission ok) + unrestricted scope (null) -> DW Data returns 200, real rows", async () => {
  const ctx = makeContext({
    guardResult: { ok: true, session: { id: "u1", username: "tranmai", fullName: "Trần Mai", role: "ADMINISTRATION", deptId: null } },
    scope: null,
  });
  const res = await ctx.GET(new Request("http://localhost/api/workers"));
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.rows, []);
});

test("RBAC role-rename: dw.view granted (requirePermission ok) BUT scope is [] (not null) -> a DISTINCT scope-denial 403, never the capability-denial message", async () => {
  const ctx = makeContext({
    guardResult: { ok: true, session: { id: "u1", username: "tranmai", fullName: "Trần Mai", role: "ADMINISTRATION", deptId: null } },
    scope: [],
  });
  const res = await ctx.GET(new Request("http://localhost/api/workers"));
  assert.equal(res.status, 403);
  const body = JSON.parse(res.body);
  assert.match(body.error, /Data Scope/, "must be the scope-specific message, not a role/permission message");
  assert.doesNotMatch(body.error, /Từ chối truy cập|không có quyền thực hiện/);
});

test("RBAC role-rename: dw.view denied (requirePermission fails) -> the CAPABILITY-denial message from the guard, scope is never even consulted", async () => {
  const ctx = makeContext({
    guardResult: { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." },
    scope: null, // irrelevant — must not be reached
  });
  const res = await ctx.GET(new Request("http://localhost/api/workers"));
  assert.equal(res.status, 403);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "Tài khoản của bạn không có quyền thực hiện thao tác này.");
});

test("RBAC role-rename: a scoped-but-non-empty department list is ALSO scope-denied (DW Data has no per-department filter to apply safely)", async () => {
  const ctx = makeContext({
    guardResult: { ok: true, session: { id: "u1", username: "manager", fullName: "Manager", role: "DEPT_MANAGER", deptId: "dept-1" } },
    scope: ["dept-1"],
  });
  const res = await ctx.GET(new Request("http://localhost/api/workers"));
  assert.equal(res.status, 403);
  const body = JSON.parse(res.body);
  assert.match(body.error, /Data Scope/);
});
