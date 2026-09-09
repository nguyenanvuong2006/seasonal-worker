/**
 * GET /api/registrations — candidate list default window vs. historical search.
 *
 * Regression for the Document Merge candidate list bug (2026-09): the list
 * used a hardcoded 14-day window with ONLY client-side substring search over
 * that already-narrow set, so a candidate registered before the window was
 * unfindable no matter what was typed. Fixed here at the source: GET now
 * accepts an optional `q` — when present it DROPS the regDate range filter
 * entirely (search the full eligible dataset) instead of narrowing search to
 * the default window; when absent, behavior is byte-for-byte unchanged
 * (regDate BETWEEN from/to, defaulting to today — this route is shared by
 * other pages, e.g. HR Registrations, that never pass q).
 *
 * Repo has no jsdom — runs the real route.ts source in a vm sandbox with a
 * fake drizzle db (matches this repo's established pattern, e.g.
 * async-job.test.ts). Unrelated POST-only imports (matching/rule-engine/
 * registration-persistence/employment/...) are stubbed as empty objects via
 * `fallback` — GET never touches them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, condsOf, type FakeDb, type QueryCall } from "../../../lib/test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../../../lib/test-support/load-module.ts";

const schemaStub = {
  dailyApplications: makeTable("daily_applications"),
  departments: makeTable("departments"),
  dwData: makeTable("dw_data"),
  employmentSessions: makeTable("employment_sessions"),
  formQuestions: makeTable("form_questions"),
  workerProfiles: makeTable("worker_profiles"),
};

function load(db: FakeDb): { GET: (r: Request) => Promise<{ status: number; body: Record<string, unknown> }> } {
  const mod = loadModule(new URL("./route.ts", import.meta.url), {
    stubs: {
      "next/server": {
        NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) },
      },
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/auth": {
        requirePermission: async () => ({
          ok: true,
          status: 200,
          session: { id: "user-1", username: "hr", fullName: "HR Staff", role: "HR_RECRUITER" },
        }),
        getUserScope: async () => null,
        hasPermission: async () => true,
      },
      "@/lib/helpers": { todayStr: () => "2026-09-09" },
      "@/lib/person-name": { normalizePersonName: (s: string | null | undefined) => s ?? "" },
      "server-only": serverOnlyStub,
    },
    // GET never touches these — used only by POST in the same file.
    fallback: () => ({}),
  });
  return mod as unknown as { GET: (r: Request) => Promise<{ status: number; body: Record<string, unknown> }> };
}

function requestFor(query: string): Request {
  return new Request(`https://app.example/api/registrations${query}`, { method: "GET" });
}

test("GET without q: unchanged — filters by regDate BETWEEN from/to, no search condition", async () => {
  let selectCall: QueryCall | null = null;
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "daily_applications") {
        selectCall = call;
        return [];
      }
      return undefined;
    },
  });
  const { GET } = load(db);

  const res = await GET(requestFor("?from=2026-08-01&to=2026-08-31&assigned=1"));
  assert.equal(res.status, 200);
  // JSON round-trip, not assert.deepEqual: loadModule runs the route in a vm
  // sandbox (a separate realm), so its returned object is structurally but
  // never reference-equal to a host-realm object literal.
  assert.equal(JSON.stringify(res.body.range), JSON.stringify({ from: "2026-08-01", to: "2026-08-31" }));

  assert.ok(selectCall, "daily_applications was queried");
  const conds = condsOf(selectCall!);
  assert.ok(conds.some((c) => c.op === "gte" && c.col === "daily_applications.regDate" && c.val === "2026-08-01"), "regDate >= from");
  assert.ok(conds.some((c) => c.op === "lte" && c.col === "daily_applications.regDate" && c.val === "2026-08-31"), "regDate <= to");
  assert.ok(!conds.some((c) => c.op === "or"), "no search OR condition when q is absent");
});

test("GET with q: drops the regDate window entirely — searches the full eligible dataset by name/CCCD/phone/mã số", async () => {
  let selectCall: QueryCall | null = null;
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "daily_applications") {
        selectCall = call;
        return [];
      }
      return undefined;
    },
  });
  const { GET } = load(db);

  const res = await GET(requestFor("?q=Nguyen+Van+A&assigned=1"));
  assert.equal(res.status, 200);
  assert.equal(JSON.stringify(res.body.range), JSON.stringify({ searched: "ALL" }));

  const conds = condsOf(selectCall!);
  assert.ok(!conds.some((c) => c.op === "gte" && c.col === "daily_applications.regDate"), "regDate >= from must be dropped when searching");
  assert.ok(!conds.some((c) => c.op === "lte" && c.col === "daily_applications.regDate"), "regDate <= to must be dropped when searching");

  const searchOr = conds.find((c) => c.op === "or");
  assert.ok(searchOr, "an OR search condition is present");
  const orParts = (searchOr as { op: "or"; parts: unknown[] }).parts;
  const searchedCols = orParts.map((p) => (p as { col?: string }).col);
  assert.ok(searchedCols.includes("daily_applications.fullName"), "searches fullName");
  assert.ok(searchedCols.includes("daily_applications.cccd"), "searches CCCD");
  assert.ok(searchedCols.includes("daily_applications.phone"), "searches phone");
  assert.ok(searchedCols.includes("daily_applications.itCode"), "searches mã số (itCode)");
});

test("GET with q still applies non-date filters (status/assigned) — search narrows within permission scope, not a bypass", async () => {
  let selectCall: QueryCall | null = null;
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "daily_applications") {
        selectCall = call;
        return [];
      }
      return undefined;
    },
  });
  const { GET } = load(db);

  await GET(requestFor("?q=123456789&assigned=1"));
  const conds = condsOf(selectCall!);
  assert.ok(conds.some((c) => c.op === "isNotNull" && c.col === "daily_applications.deptId"), "assigned=1 still filters to deptId IS NOT NULL");
  assert.ok(conds.some((c) => c.op === "ne" && c.col === "daily_applications.status" && c.val === "REJECTED"), "assigned=1 still excludes REJECTED");
  assert.ok(conds.some((c) => c.op === "isNull" && c.col === "daily_applications.deletedAt"), "soft-deleted rows are still excluded");
});
