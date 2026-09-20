import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../../../lib/test-support/load-module.ts";

/* ============================================================
   PROOF TESTS — GET /api/recruitment-requests/export
   ------------------------------------------------------------
   P2-1 audit result: FALSE_POSITIVE_WITH_PROOF.

   Route already enforces (lines 26-33 of route.ts):
     A. session check           -> 401 if not logged in
     B. planning.view OR workforce_request.view -> 403 if both missing
     C. Data Scope: getUserScope(session) called at line 36 and passed
        into listRecruitmentRequests() as filter.scope. Returns
        {rows:[], total:0} for empty scope — no data leak.
     D. No PII: recruitment_requests table has no CCCD/phone fields.
   ============================================================ */

type FakeSession = { id: string; role: string; username: string; fullName: string };
type FakeResponse = { status: number; body: Record<string, unknown> };
type GetFn = (req: Request) => Promise<FakeResponse>;

interface ListFilter {
  scope: string[] | null;
  [key: string]: unknown;
}

interface LoadOpts {
  session?: FakeSession | null;
  hasPlanningView?: boolean;
  hasWorkforceView?: boolean;
  scope?: string[] | null;
  listRows?: Record<string, unknown>[];
}

function loadRoute(opts: LoadOpts): {
  mod: Record<string, unknown>;
  listCalls: { scope: string[] | null }[];
  audits: string[];
} {
  const hasPlanningView = opts.hasPlanningView ?? true;
  const scope = opts.scope !== undefined ? opts.scope : null;
  const listRows = opts.listRows ?? [];
  const audits: string[] = [];
  const listCalls: { scope: string[] | null }[] = [];

  const mod = loadModule(new URL("./export/route.ts", import.meta.url), {
    stubs: {
      "next/server": {
        NextResponse: class FakeNextResponse {
          body: unknown;
          status: number;
          headers: Record<string, string>;
          constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
            this.body = body;
            this.status = init?.status ?? 200;
            this.headers = init?.headers ?? {};
          }
          static json(body: Record<string, unknown>, init?: { status?: number }) {
            return { status: init?.status ?? 200, body };
          }
        },
      },
      "@/lib/auth": {
        getSession: async () => opts.session !== undefined ? opts.session : { id: "u1", role: "ADMIN", username: "admin1", fullName: "Admin One" },
        getUserScope: async () => scope,
        hasPermission: async (_role: string, key: string) => {
          if (key === "planning.view") return hasPlanningView;
          if (key === "workforce_request.view") return opts.hasWorkforceView ?? false;
          return false;
        },
        writeAudit: async (_s: unknown, action: string) => { audits.push(action); },
      },
      "@/lib/excel-workbook-style": {
        addStyledSheet: () => {},
        createStyledWorkbook: () => ({ __wb: true }),
        workbookToBuffer: async () => Buffer.from("fake-xlsx"),
      },
      "@/lib/helpers": { todayStr: () => "2026-09-20" },
      "@/lib/recruitment-request": {
        listRecruitmentRequests: async (filter: ListFilter, _limit: number) => {
          listCalls.push({ scope: filter.scope });
          return { rows: listRows, total: listRows.length };
        },
      },
      "@/lib/workforce-request": {
        batchComputeRequestKpis: async (rows: { id: string }[]) => {
          const m = new Map<string, Record<string, number>>();
          for (const r of rows) {
            m.set(r.id, {
              maleRecruited: 0, femaleRecruited: 0, maleQuit: 0, femaleQuit: 0,
              maleTransferOut: 0, femaleTransferOut: 0, maleBalance: 0, femaleBalance: 0, totalBalance: 0,
            });
          }
          return m;
        },
      },
      "@/lib/workforce-request-kpi": {
        resolveDefaultAsOf: (_r: unknown, today: string) => today,
      },
    },
  });

  return { mod, listCalls, audits };
}

function makeReq(url = "http://localhost/api/recruitment-requests/export"): Request {
  return { url } as unknown as Request;
}

// ── Auth gate A: session ──────────────────────────────────────────────────────

test("unauthenticated (no session) -> 401, listRecruitmentRequests not called", async () => {
  const { mod, listCalls } = loadRoute({ session: null, hasPlanningView: false });
  const GET = mod.GET as GetFn;
  const res = await GET(makeReq());
  assert.equal(res.status, 401);
  assert.equal(listCalls.length, 0);
});

// ── Auth gate B: at least one view permission required ────────────────────────

test("missing both planning.view AND workforce_request.view -> 403", async () => {
  const { mod, listCalls } = loadRoute({ hasPlanningView: false, hasWorkforceView: false });
  const GET = mod.GET as GetFn;
  const res = await GET(makeReq());
  assert.equal(res.status, 403);
  assert.equal(listCalls.length, 0, "listRecruitmentRequests must not be called without permission");
});

test("planning.view alone is sufficient -> 200", async () => {
  const { mod } = loadRoute({ hasPlanningView: true, hasWorkforceView: false, listRows: [] });
  const GET = mod.GET as GetFn;
  const res = await GET(makeReq());
  assert.equal(res.status, 200);
});

test("workforce_request.view alone is sufficient -> 200", async () => {
  const { mod } = loadRoute({ hasPlanningView: false, hasWorkforceView: true, listRows: [] });
  const GET = mod.GET as GetFn;
  const res = await GET(makeReq());
  assert.equal(res.status, 200);
});

// ── Auth gate C: Data Scope threaded through ──────────────────────────────────

test("Data Scope: null scope (admin) -> listRecruitmentRequests called with scope=null", async () => {
  const { mod, listCalls } = loadRoute({ scope: null, listRows: [] });
  const GET = mod.GET as GetFn;
  await GET(makeReq());
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0].scope, null, "null scope must pass through for admins");
});

test("Data Scope: restricted scope -> listRecruitmentRequests called with that scope", async () => {
  const restrictedScope = ["dept-A", "dept-B"];
  const { mod, listCalls } = loadRoute({ scope: restrictedScope, listRows: [] });
  const GET = mod.GET as GetFn;
  await GET(makeReq());
  assert.equal(listCalls.length, 1);
  assert.deepEqual(listCalls[0].scope, restrictedScope, "Data Scope must be forwarded to query engine as-is");
});

test("Data Scope: empty scope [] -> listRecruitmentRequests called with [], returns 0 rows (no leak)", async () => {
  const { mod, listCalls } = loadRoute({ scope: [], listRows: [] });
  const GET = mod.GET as GetFn;
  const res = await GET(makeReq());
  assert.equal(res.status, 200);
  assert.equal(listCalls.length, 1);
  assert.deepEqual(listCalls[0].scope, [], "empty scope must not be replaced with null (would expose all data)");
});

// ── Audit written on success ──────────────────────────────────────────────────

test("authorized export -> audit EXPORT_RECRUITMENT_REQUESTS written", async () => {
  const { mod, audits } = loadRoute({ listRows: [] });
  const GET = mod.GET as GetFn;
  await GET(makeReq());
  assert.ok(audits.includes("EXPORT_RECRUITMENT_REQUESTS"), "audit must be written on every successful export");
});
