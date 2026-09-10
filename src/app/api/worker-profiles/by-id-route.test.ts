/**
 * GET /api/worker-profiles/by-id/[workerId] — RBAC + Data Scope + IDOR tests
 * (2026-09-10 Worker 360° Profile mission, Section 14).
 *
 * Sibling file (not nested under by-id/[workerId]/) — same Node test-runner
 * bracket-glob quirk documented elsewhere in this feature
 * (confirmation-history-scope.test.ts, issue-single-deadline.test.ts).
 *
 * Proves: anonymous/unauthorized callers are rejected before the service is
 * ever invoked; an invalid workerId is rejected before any DB/service call;
 * and — the CRITICAL Section 14 case — knowing a valid workerId does NOT by
 * itself grant access: when getWorker360Profile() returns null (the
 * worker exists but every engagement is outside the caller's Data Scope,
 * OR the worker doesn't exist at all), the route returns the SAME 404 in
 * both cases (never a distinguishable "exists but forbidden" vs "does not
 * exist" — no existence oracle for a scoped caller).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const ROUTE_PATH = "src/app/api/worker-profiles/by-id/[workerId]/route.ts";
const routeSource = readFileSync(new URL(`../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

type NextResponseLike = { status: number; jsonBody: Record<string, unknown> };
type Guard = { ok: true; session: { role: string } } | { ok: false; status: number; error: string };

function loadRoute(opts: { guard: Guard; profile: unknown; scope?: string[] | null }) {
  const calls: { workerId: string; scope: string[] | null }[] = [];
  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return {
            NextResponse: {
              json: (body: unknown, init?: { status?: number }): NextResponseLike => ({ status: init?.status ?? 200, jsonBody: body as Record<string, unknown> }),
            },
          };
        case "@/lib/auth":
          return {
            requirePermission: async () => opts.guard,
            getUserScope: async () => (opts.scope === undefined ? null : opts.scope),
          };
        case "@/lib/worker-360-profile":
          return {
            getWorker360Profile: async (workerId: string, scope: string[] | null) => {
              calls.push({ workerId, scope });
              return opts.profile;
            },
          };
        default:
          throw new Error(`Unexpected require("${id}") — route không được phụ thuộc module này.`);
      }
    },
    process,
    Request,
    console,
    JSON,
  });
  vm.runInContext(jsSource, context);

  const GET = (moduleObj.exports as { GET: (req: Request, ctx: { params: Promise<{ workerId: string }> }) => Promise<NextResponseLike> }).GET;
  return { GET, calls };
}

const VALID_ID = "0d3f2a10-1111-4a2b-8c3d-abcdef123456";
const FAKE_PROFILE = { person: { workerId: VALID_ID, fullName: "nguyen van a" }, engagements: [] };

test("anonymous/unauthorized caller (guard.ok=false) is rejected — the service is never invoked", async () => {
  const { GET, calls } = loadRoute({ guard: { ok: false, status: 401, error: "Chưa đăng nhập. Vui lòng đăng nhập lại." }, profile: FAKE_PROFILE });
  const res = await GET(new Request("https://app.example"), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0, "getWorker360Profile must not be called when the permission guard already rejects");
});

test("role without worker_profile.view is rejected with 403 — the service is never invoked", async () => {
  const { GET, calls } = loadRoute({ guard: { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." }, profile: FAKE_PROFILE });
  const res = await GET(new Request("https://app.example"), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("an invalid (non-UUID) workerId is rejected with 400 before the service is ever invoked", async () => {
  const { GET, calls } = loadRoute({ guard: { ok: true, session: { role: "ADMIN" } }, profile: FAKE_PROFILE });
  const res = await GET(new Request("https://app.example"), { params: Promise.resolve({ workerId: "not-a-uuid" }) });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("CCCD-shaped value passed as workerId is rejected — the URL param only ever accepts an opaque UUID, never a government ID", async () => {
  const { GET } = loadRoute({ guard: { ok: true, session: { role: "ADMIN" } }, profile: FAKE_PROFILE });
  const res = await GET(new Request("https://app.example"), { params: Promise.resolve({ workerId: "010000000001" }) });
  assert.equal(res.status, 400);
});

test("IDOR: getWorker360Profile() returning null (out-of-scope OR non-existent worker) yields 404 — never a distinguishable existence oracle", async () => {
  const { GET, calls } = loadRoute({ guard: { ok: true, session: { role: "DEPT_MANAGER" } }, profile: null, scope: ["dept-A"] });
  const res = await GET(new Request("https://app.example"), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 404);
  assert.deepEqual(calls, [{ workerId: VALID_ID, scope: ["dept-A"] }], "the route must pass the caller's ACTUAL scope through unmodified — no widening");
});

test("ADMIN with GLOBAL scope (null) sees the profile — scope is threaded through as null, not an empty array", async () => {
  const { GET, calls } = loadRoute({ guard: { ok: true, session: { role: "ADMIN" } }, profile: FAKE_PROFILE, scope: null });
  const res = await GET(new Request("https://app.example"), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.jsonBody), ["profile"]);
  assert.equal(res.jsonBody.profile, FAKE_PROFILE, "the service's profile object must be passed through unmodified");
  assert.deepEqual(calls, [{ workerId: VALID_ID, scope: null }]);
});

test("manager scoped to a department that DOES contain this worker's engagement is granted access", async () => {
  const { GET } = loadRoute({ guard: { ok: true, session: { role: "DEPT_MANAGER" } }, profile: FAKE_PROFILE, scope: ["dept-A"] });
  const res = await GET(new Request("https://app.example"), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.jsonBody.profile, FAKE_PROFILE);
});
