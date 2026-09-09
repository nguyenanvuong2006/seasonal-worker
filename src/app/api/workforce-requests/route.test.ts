/**
 * GET /api/workforce-requests — EXECUTION tests (2026-09, Production
 * incident: "Unexpected end of JSON input" on the Workforce Request page).
 * Runs the REAL route.ts (same convention as recruitment-requests/import/
 * route.test.ts) with a stubbed listWorkforceRequests(), proving:
 *   - 200 + rows on success
 *   - 200 + [] (still a valid JSON envelope) when there are no requests
 *   - a thrown exception (e.g. the real Postgres "column does not exist"
 *     this incident hit) is caught and returns a STRUCTURED {error} JSON
 *     body with HTTP 500 — never an uncaught exception, never an empty
 *     body a client's response.json() would fail to parse.
 *   - 403 (no permission) still returns a JSON body, never bypassed.
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
  listWorkforceRequests: (input: unknown) => Promise<unknown[]>;
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
      listWorkforceRequests: opts.listWorkforceRequests,
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
  return new Request(`https://app.example/api/workforce-requests${qs}`);
}

test("200 + rows: existing requests are returned as-is", async () => {
  const GET = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "ADMIN", username: "admin" } }),
    listWorkforceRequests: async () => [{ id: "r1" }, { id: "r2" }],
  });
  const res = await GET(getWith());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rows, [{ id: "r1" }, { id: "r2" }]);
});

test("200 + [] : a true empty dataset is still HTTP 200 with a valid JSON envelope, never an empty body", async () => {
  const GET = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "ADMIN", username: "admin" } }),
    listWorkforceRequests: async () => [],
  });
  const res = await GET(getWith());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rows, []);
  assert.ok("can" in res.body, "success envelope must still carry the `can` capabilities object");
});

test("structured 4xx JSON: no permission -> 403 with a JSON {error} body, service never called", async () => {
  let called = false;
  const GET = loadRoute({
    guardFor: () => ({ ok: false, status: 403, error: "Không có quyền." }),
    listWorkforceRequests: async () => {
      called = true;
      return [];
    },
  });
  const res = await GET(getWith());
  assert.equal(res.status, 403);
  assert.equal(typeof res.body.error, "string");
  assert.equal(called, false, "the service must never be called once permission is denied");
});

test("structured 5xx JSON: an exception from listWorkforceRequests() (e.g. the real 'column does not exist' this incident hit) never escapes uncaught", async () => {
  const GET = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "ADMIN", username: "admin" } }),
    listWorkforceRequests: async () => {
      throw new Error('column "male_current_at_start" does not exist');
    },
  });
  const res = await GET(getWith());
  assert.equal(res.status, 500);
  assert.equal(typeof res.body.error, "string");
  const message = res.body.error as string;
  assert.ok(message.length > 0, "must be a real, non-empty JSON error body — never an empty response");
  // The raw Postgres error text/column name must never leak to the client.
  assert.ok(!message.includes("male_current_at_start"));
});
