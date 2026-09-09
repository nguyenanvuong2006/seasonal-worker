/**
 * GET /api/workforce-requests/dashboard — EXECUTION tests (2026-09,
 * Production incident). Same convention as ../route.test.ts — proves the
 * dashboard's own exception path (independent from the list's) is caught
 * and returns a structured {error} JSON body on HTTP 500, never an
 * uncaught exception/empty body.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

type Guard =
  | { ok: true; session: { userId: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

type RouteResponse = { status: number; body: Record<string, unknown> };

function loadRoute(opts: {
  guardFor: (roles: string[], key: string) => Guard;
  getRequestDashboard: (scope: unknown, asOf: string) => Promise<unknown>;
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: {
        json: (body: Record<string, unknown>, init?: { status?: number }): RouteResponse => ({
          status: init?.status ?? 200,
          body,
        }),
      },
    },
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => opts.guardFor(roles, key),
      getUserScope: async () => null,
      hasPermission: async () => true,
    },
    "@/lib/workforce-request": {
      getRequestDashboard: opts.getRequestDashboard,
    },
    "@/lib/helpers": {
      todayStr: () => "2026-09-09",
    },
  };

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      if (id in stubs) return stubs[id];
      throw new Error(`Unexpected require("${id}") — route không được phụ thuộc module này.`);
    },
    process,
    Request,
    URL,
    console,
    JSON,
  });
  vm.runInContext(js, context);

  return (moduleObj.exports as { GET: (req: Request) => Promise<RouteResponse> }).GET;
}

function getWith(qs = ""): Request {
  return new Request(`https://app.example/api/workforce-requests/dashboard${qs}`);
}

test("200 + dashboard summary on success", async () => {
  const GET = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "ADMIN", username: "admin" } }),
    getRequestDashboard: async () => ({ summary: { totalRequested: { male: 1, female: 1, total: 2 } }, rows: [], source: "LIVE", computedAt: "now", asOfDate: "2026-09-09" }),
  });
  const res = await GET(getWith());
  assert.equal(res.status, 200);
  assert.ok(res.body.summary);
});

test("structured 5xx JSON: an exception from getRequestDashboard() never escapes uncaught", async () => {
  const GET = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "ADMIN", username: "admin" } }),
    getRequestDashboard: async () => {
      throw new Error('column "male_current_at_start" does not exist');
    },
  });
  const res = await GET(getWith());
  assert.equal(res.status, 500);
  assert.equal(typeof res.body.error, "string");
  const message = res.body.error as string;
  assert.ok(message.length > 0);
  assert.ok(!message.includes("male_current_at_start"));
});

test("structured 4xx JSON: no permission -> 403, service never called", async () => {
  let called = false;
  const GET = loadRoute({
    guardFor: () => ({ ok: false, status: 403, error: "Không có quyền." }),
    getRequestDashboard: async () => {
      called = true;
      return {};
    },
  });
  const res = await GET(getWith());
  assert.equal(res.status, 403);
  assert.equal(typeof res.body.error, "string");
  assert.equal(called, false);
});
