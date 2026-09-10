import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/**
 * GET /api/employment/current-workforce — route-level proof that the RBAC guard runs before
 * the roster service is ever called, that filter/deptId query params are threaded through to
 * getDepartmentWorkforceRoster() correctly, and that an unrecognized filter value falls back
 * to the safe default (ACTIVE) instead of an arbitrary/unvalidated string reaching the service.
 */

type Guard = { ok: true; session: { id: string; role: string; username: string } } | { ok: false; status: number; error: string };
type Response = { status: number; body: Record<string, unknown> };

function loadRoute(opts: { guard: Guard; scope?: string[] | null; rows?: unknown[] }) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }): Response => ({ status: init?.status ?? 200, body }) } },
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => {
        calls.push({ fn: "requirePermission", args: [roles, key] });
        return opts.guard;
      },
      getUserScope: async () => {
        calls.push({ fn: "getUserScope", args: [] });
        return opts.scope ?? null;
      },
    },
    "@/lib/workforce-roster": {
      getDepartmentWorkforceRoster: async (scope: unknown, filter: unknown, deptId: unknown) => {
        calls.push({ fn: "getDepartmentWorkforceRoster", args: [scope, filter, deptId] });
        return opts.rows ?? [];
      },
    },
  };

  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      if (id in stubs) return stubs[id];
      throw new Error(`Unexpected require("${id}")`);
    },
    process,
    Request,
    URL,
    URLSearchParams,
    console,
    JSON,
  });
  vm.runInContext(js, context);

  return { GET: (moduleObj.exports as { GET: (req: Request) => Promise<Response> }).GET, calls };
}

const OWNER_GUARD: Guard = { ok: true, session: { id: "u1", role: "DEPT_MANAGER", username: "manager1" } };
const DENIED_GUARD: Guard = { ok: false, status: 403, error: "Không có quyền." };

test("denied guard -> 403, roster service never called, scope never resolved", async () => {
  const { GET, calls } = loadRoute({ guard: DENIED_GUARD });
  const res = await GET(new Request("https://app.example/api/employment/current-workforce"));
  assert.equal(res.status, 403);
  assert.ok(!calls.some((c) => c.fn === "getDepartmentWorkforceRoster"));
  assert.ok(!calls.some((c) => c.fn === "getUserScope"));
});

test("permission check is gated on registrations.view (same permission the page always required)", async () => {
  const { GET, calls } = loadRoute({ guard: OWNER_GUARD });
  await GET(new Request("https://app.example/api/employment/current-workforce"));
  const permCall = calls.find((c) => c.fn === "requirePermission");
  assert.equal(permCall!.args[1], "registrations.view");
});

test("no filter param -> defaults to ACTIVE", async () => {
  const { GET, calls } = loadRoute({ guard: OWNER_GUARD });
  await GET(new Request("https://app.example/api/employment/current-workforce"));
  const rosterCall = calls.find((c) => c.fn === "getDepartmentWorkforceRoster");
  assert.equal(rosterCall!.args[1], "ACTIVE");
});

test("an unrecognized filter value falls back to ACTIVE, never reaches the service as an arbitrary string", async () => {
  const { GET, calls } = loadRoute({ guard: OWNER_GUARD });
  await GET(new Request("https://app.example/api/employment/current-workforce?filter=DROP TABLE workers"));
  const rosterCall = calls.find((c) => c.fn === "getDepartmentWorkforceRoster");
  assert.equal(rosterCall!.args[1], "ACTIVE");
});

test("a valid filter + deptId are threaded through to the roster service, and the session's OWN resolved scope is used (never client-supplied)", async () => {
  const { GET, calls } = loadRoute({ guard: OWNER_GUARD, scope: ["d1", "d2"] });
  await GET(new Request("https://app.example/api/employment/current-workforce?filter=UPCOMING_RESIGNATION&deptId=d1"));
  const rosterCall = calls.find((c) => c.fn === "getDepartmentWorkforceRoster");
  assert.deepEqual(rosterCall!.args[0], ["d1", "d2"]);
  assert.equal(rosterCall!.args[1], "UPCOMING_RESIGNATION");
  assert.equal(rosterCall!.args[2], "d1");
});

test("200 response envelope carries rows + echoes the resolved filter", async () => {
  const { GET } = loadRoute({ guard: OWNER_GUARD, rows: [{ workerId: "w1" }] });
  const res = await GET(new Request("https://app.example/api/employment/current-workforce?filter=RESIGNED"));
  assert.equal(res.status, 200);
  assert.equal((res.body.rows as unknown[]).length, 1);
  assert.equal(res.body.filter, "RESIGNED");
});
