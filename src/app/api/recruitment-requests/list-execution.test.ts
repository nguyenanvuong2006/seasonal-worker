/**
 * GET /api/recruitment-requests — EXECUTION tests (2026-09, Production
 * incident: "Máy chủ gặp sự cố (HTTP 500) — recruitment-requests.list").
 * Same convention as import/route.test.ts — proves:
 *   - 200 + rows/total on success
 *   - 200 + [] for a true empty result
 *   - an exception from listRecruitmentRequests() (the real Postgres
 *     "column does not exist" this incident hit) is caught and returns a
 *     structured {error} JSON body on HTTP 500 — never an uncaught
 *     exception/empty body.
 *   - 403 (no permission) still returns JSON, service never called.
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
  listRecruitmentRequests: (filter: unknown, limit: number, offset: number) => Promise<{ rows: unknown[]; total: number }>;
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
    "drizzle-orm": { and: () => undefined, eq: () => undefined, inArray: () => undefined, isNull: () => undefined },
    "@/db": { db: {} },
    "@/db/schema": { recruitmentRequests: {} },
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => opts.guardFor(roles, key),
      requireAnyPermission: async (roles: string[], keys: string[]) => opts.guardFor(roles, keys.join("|")),
      getUserScope: async () => null,
      writeAudit: async () => {},
    },
    "@/lib/data-scope": { scopeAllowsDepartment: () => true },
    "@/lib/recruitment-request": {
      listRecruitmentRequests: opts.listRecruitmentRequests,
      matchHierarchy: async () => ({ deptId: null }),
    },
    "@/lib/planning-recruitment-core": {
      REQUEST_STATUSES: ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED", "EXPIRED"],
      computeDateDeltas: () => ({}),
      computeTotalRequest: () => 0,
      stripSystemOwnedFields: (body: Record<string, unknown>) => ({ safe: body, rejected: [] }),
    },
    "@/lib/recruitment-request-provisioning": { provisionRecruitmentRequest: async () => {} },
    "@/lib/workforce-request": {
      batchComputeRequestKpis: async () => new Map(),
    },
    "@/lib/workforce-request-kpi": {
      resolveDefaultAsOf: (_r: unknown, today: string) => today,
    },
    "@/lib/helpers": { todayStr: () => "2026-09-10" },
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
    Map,
  });
  vm.runInContext(js, context);

  return (moduleObj.exports as { GET: (req: Request) => Promise<RouteResponse> }).GET;
}

function getWith(qs = ""): Request {
  return new Request(`https://app.example/api/recruitment-requests${qs}`);
}

test("200 + rows/total on success", async () => {
  const GET = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "ADMIN", username: "admin" } }),
    listRecruitmentRequests: async () => ({ rows: [{ id: "r1" }], total: 1 }),
  });
  const res = await GET(getWith());
  assert.equal(res.status, 200);
  // JSON round-trip: rows được dựng bằng object spread BÊN TRONG vm sandbox (realm
  // khác với test file) — assert.deepEqual so sánh cross-realm object sẽ báo "same
  // structure but not reference-equal"; JSON.stringify/parse chuẩn hoá về plain object
  // cùng realm với test, không đổi ý nghĩa so sánh.
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.rows)), [{ id: "r1", kpi: null }]);
  assert.equal(res.body.total, 1);
});

test("200 + [] : a true empty dataset is still HTTP 200 with a valid JSON envelope", async () => {
  const GET = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "ADMIN", username: "admin" } }),
    listRecruitmentRequests: async () => ({ rows: [], total: 0 }),
  });
  const res = await GET(getWith());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rows, []);
  assert.equal(res.body.total, 0);
});

test("structured 4xx JSON: no permission -> 403, service never called", async () => {
  let called = false;
  const GET = loadRoute({
    guardFor: () => ({ ok: false, status: 403, error: "Không có quyền." }),
    listRecruitmentRequests: async () => {
      called = true;
      return { rows: [], total: 0 };
    },
  });
  const res = await GET(getWith());
  assert.equal(res.status, 403);
  assert.equal(typeof res.body.error, "string");
  assert.equal(called, false);
});

test("structured 5xx JSON: an exception from listRecruitmentRequests() (the real 'column does not exist' this incident hit) never escapes uncaught", async () => {
  const GET = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "ADMIN", username: "admin" } }),
    listRecruitmentRequests: async () => {
      throw new Error('column "male_current_at_start" does not exist');
    },
  });
  const res = await GET(getWith());
  assert.equal(res.status, 500);
  assert.equal(typeof res.body.error, "string");
  const message = res.body.error as string;
  assert.ok(message.length > 0, "must be a real, non-empty JSON error body — never an empty response");
  assert.ok(!message.includes("male_current_at_start"), "raw Postgres error text must never leak to the client");
});
