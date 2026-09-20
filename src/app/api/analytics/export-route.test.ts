import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../../../lib/test-support/load-module.ts";

/* ============================================================
   PROOF TESTS — GET /api/analytics/export
   ------------------------------------------------------------
   P2-1 audit result: FALSE_POSITIVE_WITH_PROOF.

   Route already enforces (lines 23-30 of route.ts):
     A. session check           -> 401 if not logged in
     B. registrations.export    -> 403 if missing
     C. dashboard.view          -> 403 if missing
     D. Data Scope via getDashboardAnalytics(session) /
        getAnalyticsDetailRows(session) — both call getUserScope()
        internally and restrict rows to caller scope.
     E. CCCD masked: only included when role has privacy.view_cccd.
   ============================================================ */

type FakeSession = { id: string; role: string; username: string };
type FakeResponse = { status: number; body: Record<string, unknown> };
type GetFn = (req: Request) => Promise<FakeResponse>;

interface AnalyticsFilters {
  from: string;
  to: string;
  location: unknown;
  division: unknown;
  departmentId: unknown;
  section: unknown;
  groupName: unknown;
}

interface LoadOpts {
  session?: FakeSession | null;
  canExport?: boolean;
  canDashboard?: boolean;
  canCccd?: boolean;
  detailRows?: Record<string, string>[];
}

function loadRoute(opts: LoadOpts): {
  mod: Record<string, unknown>;
  dashboardRows: { session: FakeSession; filters: AnalyticsFilters }[];
  detailCalls: { session: FakeSession; filters: AnalyticsFilters; opts: { includeCccd: boolean } }[];
  audits: string[];
} {
  const canExport = opts.canExport ?? true;
  const canDashboard = opts.canDashboard ?? true;
  const canCccd = opts.canCccd ?? false;
  const detailRows = opts.detailRows ?? [{ field: "value" }];
  const dashboardRows: { session: FakeSession; filters: AnalyticsFilters }[] = [];
  const audits: string[] = [];
  const detailCalls: { session: FakeSession; filters: AnalyticsFilters; opts: { includeCccd: boolean } }[] = [];

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
      "exceljs": {
        __esModule: true,
        default: {
          Workbook: class FakeWorkbook {
            creator = "";
            created: Date | null = null;
            worksheets: unknown[] = [];
            addWorksheet(_name: string) {
              const cells: Record<string, { value: unknown; font: unknown; fill: unknown }> = {};
              const rows: unknown[] = [];
              const ws = {
                cells,
                rows,
                mergeCells: () => {},
                getCell: (addr: string) => {
                  if (!cells[addr]) cells[addr] = { value: null, font: {}, fill: {} };
                  return cells[addr];
                },
                addRow: (data: unknown) => {
                  const r = { data, font: {}, fill: {}, eachCell: (_fn: unknown) => {} };
                  rows.push(r);
                  return r;
                },
              };
              Object.defineProperty(ws, "columns", {
                get: () => ({ forEach: () => {} }),
                configurable: true,
              });
              this.worksheets.push(ws);
              return ws;
            }
            get xlsx() { return { writeBuffer: async () => Buffer.from("fake-xlsx") }; }
          },
        },
      },
      "@/lib/auth": {
        getSession: async () => opts.session !== undefined ? opts.session : { id: "u1", role: "ADMIN", username: "admin1" },
        hasPermission: async (_role: string, key: string) => {
          if (key === "registrations.export") return canExport;
          if (key === "dashboard.view") return canDashboard;
          if (key === "privacy.view_cccd") return canCccd;
          return false;
        },
        writeAudit: async (_s: unknown, action: string) => { audits.push(action); },
      },
      "@/lib/helpers": { formatDate: (d: string) => d, todayStr: () => "2026-09-20" },
      "@/lib/analytics-core": {
        parseAnalyticsFilters: (_params: unknown, today: string) => ({
          ok: true,
          filters: {
            from: "2026-09-01",
            to: today,
            location: null,
            division: null,
            departmentId: null,
            section: null,
            groupName: null,
          } satisfies AnalyticsFilters,
        }),
      },
      "@/lib/analytics": {
        getDashboardAnalytics: async (session: FakeSession, filters: AnalyticsFilters) => {
          dashboardRows.push({ session, filters });
          return {
            range: { from: filters.from, to: filters.to, previousFrom: "2026-08-01", previousTo: "2026-08-31" },
            kpis: {
              applications: { current: 10, previous: 8, changePct: 25 },
              uniqueWorkers: { current: 8, previous: 6, changePct: 33 },
              newWorkers: { current: 3, previous: 2, changePct: 50 },
              returningWorkers: { current: 5, previous: 4, changePct: 25 },
              approved: { current: 7, previous: 5, changePct: 40 },
              started: { current: 6, previous: 4, changePct: 50 },
              demand: { current: 20, previous: null, changePct: null },
              shortage: { current: 14, previous: null, changePct: null },
            },
            funnel: { stages: [], overallConversionPct: 60 },
            referralSources: [],
            planning: null,
            departmentPerformance: [],
            movements: { effective: { resignations: 1, transfersIn: 0, transfersOut: 1 } },
            dataQuality: {},
          };
        },
        getAnalyticsDetailRows: async (session: FakeSession, filters: AnalyticsFilters, o: { includeCccd: boolean }) => {
          detailCalls.push({ session, filters, opts: o });
          return detailRows;
        },
      },
    },
  });

  return { mod, dashboardRows, detailCalls, audits };
}

function makeReq(url = "http://localhost/api/analytics/export"): Request {
  return { url } as unknown as Request;
}

// ── Auth gate A: session ──────────────────────────────────────────────────────

test("unauthenticated (no session) -> 401", async () => {
  const { mod } = loadRoute({ session: null, canExport: false, canDashboard: false });
  const GET = mod.GET as GetFn;
  const res = await GET(makeReq());
  assert.equal(res.status, 401);
});

// ── Auth gate B: registrations.export permission ──────────────────────────────

test("missing registrations.export permission -> 403", async () => {
  const { mod, dashboardRows } = loadRoute({ canExport: false, canDashboard: true });
  const GET = mod.GET as GetFn;
  const res = await GET(makeReq());
  assert.equal(res.status, 403);
  assert.equal(dashboardRows.length, 0, "getDashboardAnalytics must not be called when export permission missing");
});

// ── Auth gate C: dashboard.view permission ────────────────────────────────────

test("missing dashboard.view permission -> 403", async () => {
  const { mod, dashboardRows } = loadRoute({ canExport: true, canDashboard: false });
  const GET = mod.GET as GetFn;
  const res = await GET(makeReq());
  assert.equal(res.status, 403);
  assert.equal(dashboardRows.length, 0);
});

// ── Auth gate D: authorized summary export succeeds ───────────────────────────

test("authorized summary export -> 200, audit written", async () => {
  const { mod, dashboardRows, audits } = loadRoute({ canExport: true, canDashboard: true });
  const GET = mod.GET as GetFn;
  const res = await GET(makeReq("http://localhost/api/analytics/export?mode=summary"));
  assert.equal(res.status, 200);
  assert.equal(dashboardRows.length, 1, "getDashboardAnalytics must be called with caller session");
  assert.ok(audits.includes("EXPORT_ANALYTICS"));
});

// ── Auth gate E: CCCD masking in detailed export ──────────────────────────────

test("detailed export without privacy.view_cccd -> includeCccd=false", async () => {
  const { mod, detailCalls } = loadRoute({ canExport: true, canDashboard: true, canCccd: false, detailRows: [{ "Ho ten": "Nguyen A" }] });
  const GET = mod.GET as GetFn;
  await GET(makeReq("http://localhost/api/analytics/export?mode=detailed"));
  assert.equal(detailCalls.length, 1);
  assert.equal(detailCalls[0].opts.includeCccd, false, "includeCccd must be false when caller lacks privacy.view_cccd");
});

test("detailed export with privacy.view_cccd -> includeCccd=true", async () => {
  const { mod, detailCalls } = loadRoute({ canExport: true, canDashboard: true, canCccd: true });
  const GET = mod.GET as GetFn;
  await GET(makeReq("http://localhost/api/analytics/export?mode=detailed"));
  assert.equal(detailCalls.length, 1);
  assert.equal(detailCalls[0].opts.includeCccd, true, "includeCccd must be true when caller has privacy.view_cccd");
});

// ── Auth gate D (scope): Data Scope threaded via session ───────────────────────

test("Data Scope is threaded via session object to getDashboardAnalytics", async () => {
  const session: FakeSession = { id: "u2", role: "DEPT_MANAGER", username: "mgr1" };
  const { mod, dashboardRows } = loadRoute({ session, canExport: true, canDashboard: true });
  const GET = mod.GET as GetFn;
  await GET(makeReq("http://localhost/api/analytics/export?mode=summary"));
  assert.equal(dashboardRows.length, 1);
  assert.deepEqual(dashboardRows[0].session, session, "session passed to getDashboardAnalytics must be the caller session");
});
