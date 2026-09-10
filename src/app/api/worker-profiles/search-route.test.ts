/**
 * GET /api/worker-profiles/search — RBAC + Data Scope tests (2026-09-10
 * Worker 360° Profile mission, Section 14 + 15).
 *
 * Sibling file (not nested under search/) — same Node test-runner
 * bracket-glob quirk documented elsewhere in this feature.
 *
 * Proves: unauthorized callers are rejected before any query runs; a
 * scoped caller with an EMPTY scope (assigned to zero departments) gets
 * zero results without a query ever reaching the DB; CCCD/phone are
 * masked unless the caller holds the dedicated privacy.* permission
 * (never leaked just because worker_profile.view is granted); results
 * only ever carry the opaque workerId, never CCCD, in the href-bound
 * field.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type QueryCall } from "../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/worker-profiles/search/route.ts";
const routeSource = readFileSync(new URL(`../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  employmentSessions: makeTable("employment_sessions"),
  workerProfiles: makeTable("worker_profiles"),
};

type NextResponseLike = { status: number; jsonBody: Record<string, unknown> };
type Guard = { ok: true; session: { role: string } } | { ok: false; status: number; error: string };

const ROWS = [{ id: "worker-1", cccd: "010000000001", fullName: "nguyen van a", phone: "0900000001" }];

function loadRoute(opts: { guard: Guard; scope?: string[] | null; canViewCccd?: boolean; canViewPhone?: boolean; dbRows?: typeof ROWS }) {
  let selectCalled = false;
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "worker_profiles") {
        selectCalled = true;
        return opts.dbRows ?? ROWS;
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
              json: (body: unknown, init?: { status?: number }): NextResponseLike => ({ status: init?.status ?? 200, jsonBody: body as Record<string, unknown> }),
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
            requirePermission: async () => opts.guard,
            getUserScope: async () => (opts.scope === undefined ? null : opts.scope),
            hasPermission: async (_role: string, key: string) => (key === "privacy.view_cccd" ? !!opts.canViewCccd : key === "privacy.view_phone" ? !!opts.canViewPhone : false),
          };
        case "@/lib/person-name":
          return { normalizePersonName: (s: string) => s };
        default:
          throw new Error(`Unexpected require("${id}") — route không được phụ thuộc module này.`);
      }
    },
    process,
    Request,
    URL,
    console,
    JSON,
  });
  vm.runInContext(jsSource, context);

  const GET = (moduleObj.exports as { GET: (req: Request) => Promise<NextResponseLike> }).GET;
  return { GET, selectCalled: () => selectCalled };
}

test("anonymous/unauthorized caller is rejected before any DB query runs", async () => {
  const { GET, selectCalled } = loadRoute({ guard: { ok: false, status: 401, error: "Chưa đăng nhập." } });
  const res = await GET(new Request("https://app.example?q=nguyen"));
  assert.equal(res.status, 401);
  assert.equal(selectCalled(), false);
});

test("scope with zero assigned departments (Data Scope NONE) returns zero results WITHOUT ever querying the DB", async () => {
  const { GET, selectCalled } = loadRoute({ guard: { ok: true, session: { role: "DEPT_MANAGER" } }, scope: [] });
  const res = await GET(new Request("https://app.example?q=nguyen"));
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.jsonBody), ["results"]);
  assert.equal((res.jsonBody.results as unknown[]).length, 0);
  assert.equal(selectCalled(), false, "a NONE-scoped caller must never reach the DB — not even a query that would legitimately return zero rows");
});

test("query shorter than the minimum length returns empty results without querying the DB", async () => {
  const { GET, selectCalled } = loadRoute({ guard: { ok: true, session: { role: "ADMIN" } } });
  const res = await GET(new Request("https://app.example?q=a"));
  assert.deepEqual(Object.keys(res.jsonBody), ["results"]);
  assert.equal((res.jsonBody.results as unknown[]).length, 0);
  assert.equal(selectCalled(), false);
});

test("CCCD and phone are masked by default — worker_profile.view alone never grants privacy.view_cccd/privacy.view_phone", async () => {
  const { GET } = loadRoute({ guard: { ok: true, session: { role: "HR_RECRUITER" } }, canViewCccd: false, canViewPhone: false });
  const res = await GET(new Request("https://app.example?q=nguyen"));
  const results = res.jsonBody.results as { workerId: string; cccdMasked: string; phoneMasked: string | null }[];
  assert.equal(results.length, 1);
  assert.equal(results[0].workerId, "worker-1");
  assert.notEqual(results[0].cccdMasked, "010000000001");
  assert.notEqual(results[0].phoneMasked, "0900000001");
});

test("CCCD and phone are shown in full only when the caller holds the dedicated privacy.* permissions", async () => {
  const { GET } = loadRoute({ guard: { ok: true, session: { role: "ADMIN" } }, canViewCccd: true, canViewPhone: true });
  const res = await GET(new Request("https://app.example?q=nguyen"));
  const results = res.jsonBody.results as { cccdMasked: string; phoneMasked: string | null }[];
  assert.equal(results[0].cccdMasked, "010000000001");
  assert.equal(results[0].phoneMasked, "0900000001");
});

test("result objects never carry a bare cccd field — only the opaque workerId is exposed for downstream links", async () => {
  const { GET } = loadRoute({ guard: { ok: true, session: { role: "ADMIN" } }, canViewCccd: true, canViewPhone: true });
  const res = await GET(new Request("https://app.example?q=nguyen"));
  const results = res.jsonBody.results as Record<string, unknown>[];
  assert.equal("cccd" in results[0], false);
  assert.equal("id" in results[0], false, "must be renamed to workerId, never the raw column name");
});
