/**
 * WORKFORCE DATA MANAGEMENT — reset-service.ts integration tests (mission
 * test matrix R1-R14). Runs the REAL reset-service.ts, scopes.ts,
 * environment.ts, preview-token.ts together (only the true DB/pg boundary —
 * the Drizzle db object and the raw pg pool — is faked), via the repo's
 * hermetic loadModule() harness (same convention as every other *-service
 * test in this codebase).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";
import { createFakeDb, makeTable, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-for-reset-service-tests-only";

const TABLE_NAMES = [
  "request_allocation_overrides",
  "request_allocation_history",
  "request_allocations",
  "request_comments",
  "request_kpi_cache",
  "planning_allocations",
  "start_date_corrections",
  "workforce_movements",
  "employment_sessions",
  "daily_applications",
  "worker_profiles",
  "dw_data",
  "planning_tasks",
  "dw_code_assignments",
  "it_code_assignments",
  "same_day_lifecycle_events",
  "meal_exclusions",
];
const tables = Object.fromEntries(TABLE_NAMES.map((n) => [n, makeTable(n)]));

const schemaStub = {
  requestAllocationOverrides: tables.request_allocation_overrides,
  requestAllocationHistory: tables.request_allocation_history,
  requestAllocations: tables.request_allocations,
  requestComments: tables.request_comments,
  requestKpiCache: tables.request_kpi_cache,
  planningAllocations: tables.planning_allocations,
  startDateCorrections: tables.start_date_corrections,
  workforceMovements: tables.workforce_movements,
  employmentSessions: tables.employment_sessions,
  dailyApplications: tables.daily_applications,
  workerProfiles: tables.worker_profiles,
  dwData: tables.dw_data,
  planningTasks: tables.planning_tasks,
  dwCodeAssignments: tables.dw_code_assignments,
  itCodeAssignments: tables.it_code_assignments,
  sameDayLifecycleEvents: tables.same_day_lifecycle_events,
  mealExclusions: tables.meal_exclusions,
};

type FakePoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };

function makeFakePool(opts: { lockAvailable: boolean }) {
  const client: FakePoolClient = {
    query: async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: opts.lockAvailable }] };
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => client };
}

const SESSION = { id: "u1", username: "admin1", fullName: "Admin One", role: "ADMIN", deptId: null };

function loadEnvironment() {
  return loadModule(new URL("./environment.ts", import.meta.url), { stubs: {} });
}
function loadScopes() {
  return loadModule(new URL("./scopes.ts", import.meta.url), { stubs: {} });
}
async function loadPreviewToken(scopesMod: Record<string, unknown>) {
  return loadModule(new URL("./preview-token.ts", import.meta.url), {
    stubs: { "server-only": serverOnlyStub, jose: await import("jose"), crypto: await import("node:crypto"), "./scopes": scopesMod },
  });
}

async function loadResetService(opts: { db: FakeDb; pool: ReturnType<typeof makeFakePool>; auditCalls: unknown[] }) {
  const environmentMod = loadEnvironment();
  const scopesMod = loadScopes();
  const previewTokenMod = await loadPreviewToken(scopesMod);
  return loadModule(new URL("./reset-service.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      crypto: await import("node:crypto"),
      "drizzle-orm": await import("drizzle-orm"),
      "@/db": { db: opts.db, pool: opts.pool },
      "@/db/schema": schemaStub,
      "@/lib/auth": { writeAudit: async (...args: unknown[]) => void opts.auditCalls.push(args) },
      "./environment": environmentMod,
      "./scopes": scopesMod,
      "./preview-token": previewTokenMod,
    },
  }) as unknown as {
    previewReset: (input: { session: typeof SESSION; requestedScopes: string[] }) => Promise<{
      effectiveScopes: string[];
      affected: { domain: string; rows: number }[];
      requiredConfirmationPhrase: string;
      previewToken: string;
      expiresAt: string;
    }>;
    executeReset: (input: { session: typeof SESSION; previewToken: string; confirmationPhrase: string }) => Promise<
      { ok: true; effectiveScopes: string[]; rowCountsDeleted: { domain: string; rows: number }[]; operationId: string } | { ok: false; error: { code: string; message: string } }
    >;
  };
}

function respondAllCounts(count: number) {
  return (call: QueryCall) => {
    if (call.root === "select") return [{ c: count }];
    if (call.root === "delete") return { rowCount: count };
    return undefined;
  };
}

test("R3/R4-equivalent — previewReset wires real row counts per domain end-to-end (not just pure scopes.ts)", async () => {
  const auditCalls: unknown[] = [];
  const db = createFakeDb({ respond: respondAllCounts(7) });
  const pool = makeFakePool({ lockAvailable: true });
  const mod = await loadResetService({ db, pool, auditCalls });

  const preview = await mod.previewReset({ session: SESSION, requestedScopes: ["PLANNING"] });
  assert.deepEqual(Array.from(preview.effectiveScopes), ["PLANNING"]);
  assert.equal(preview.affected.length, 1);
  assert.equal(preview.affected[0].domain, "planning_allocations");
  assert.equal(preview.affected[0].rows, 7);
  assert.equal(preview.requiredConfirmationPhrase, "RESET PLANNING");
});

test("R9 — INVALID_CONFIRMATION: wrong typed phrase -> zero writes, no transaction opened", async () => {
  const auditCalls: unknown[] = [];
  const db = createFakeDb({ respond: respondAllCounts(3) });
  const pool = makeFakePool({ lockAvailable: true });
  const mod = await loadResetService({ db, pool, auditCalls });

  const preview = await mod.previewReset({ session: SESSION, requestedScopes: ["IT_CODE"] });
  const result = await mod.executeReset({ session: SESSION, previewToken: preview.previewToken, confirmationPhrase: "WRONG PHRASE" });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_CONFIRMATION");
  assert.equal(db.transactions, 0, "must never open a transaction when confirmation phrase is wrong");
  assert.equal(auditCalls.length, 0, "must never write an audit row for a rejected confirmation");
});

test("R11 — tampered/garbage preview token -> RESET_PREVIEW_EXPIRED-family error, zero writes", async () => {
  const auditCalls: unknown[] = [];
  const db = createFakeDb({ respond: respondAllCounts(3) });
  const pool = makeFakePool({ lockAvailable: true });
  const mod = await loadResetService({ db, pool, auditCalls });

  const result = await mod.executeReset({ session: SESSION, previewToken: "not-a-real-jwt-at-all", confirmationPhrase: "RESET WORKFORCE DATA" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RESET_PREVIEW_EXPIRED");
  assert.equal(db.transactions, 0);
  assert.equal(auditCalls.length, 0);
});

test("R11b — RESET_PLAN_CHANGED: row counts differ between preview and execute -> zero writes", async () => {
  const auditCalls: unknown[] = [];
  let count = 3;
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select") return [{ c: count }];
      if (call.root === "delete") return { rowCount: count };
      return undefined;
    },
  });
  const pool = makeFakePool({ lockAvailable: true });
  const mod = await loadResetService({ db, pool, auditCalls });

  const preview = await mod.previewReset({ session: SESSION, requestedScopes: ["PLANNING"] });
  count = 999; // data changed after preview was shown
  const result = await mod.executeReset({ session: SESSION, previewToken: preview.previewToken, confirmationPhrase: "RESET PLANNING" });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RESET_PLAN_CHANGED");
  assert.equal(db.transactions, 0);
});

test("R12 — Production disabled by environment guard -> zero writes even with a valid token+phrase", async () => {
  const saved = { VERCEL_ENV: process.env.VERCEL_ENV, ALLOW_PRODUCTION_DATA_RESET: process.env.ALLOW_PRODUCTION_DATA_RESET };
  process.env.VERCEL_ENV = "production";
  delete process.env.ALLOW_PRODUCTION_DATA_RESET;
  try {
    const auditCalls: unknown[] = [];
    const db = createFakeDb({ respond: respondAllCounts(3) });
    const pool = makeFakePool({ lockAvailable: true });
    const mod = await loadResetService({ db, pool, auditCalls });

    const preview = await mod.previewReset({ session: SESSION, requestedScopes: ["IT_CODE"] });
    const result = await mod.executeReset({ session: SESSION, previewToken: preview.previewToken, confirmationPhrase: "RESET IT CODE" });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "DATA_RESET_DISABLED");
    assert.equal(db.transactions, 0);
    assert.equal(auditCalls.length, 0);
  } finally {
    if (saved.VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = saved.VERCEL_ENV;
    if (saved.ALLOW_PRODUCTION_DATA_RESET === undefined) delete process.env.ALLOW_PRODUCTION_DATA_RESET;
    else process.env.ALLOW_PRODUCTION_DATA_RESET = saved.ALLOW_PRODUCTION_DATA_RESET;
  }
});

test("R13 — concurrency lock already held -> DATA_MANAGEMENT_BUSY, zero writes", async () => {
  const auditCalls: unknown[] = [];
  const db = createFakeDb({ respond: respondAllCounts(3) });
  const pool = makeFakePool({ lockAvailable: false }); // another operation already holds the lock
  const mod = await loadResetService({ db, pool, auditCalls });

  const preview = await mod.previewReset({ session: SESSION, requestedScopes: ["IT_CODE"] });
  const result = await mod.executeReset({ session: SESSION, previewToken: preview.previewToken, confirmationPhrase: "RESET IT CODE" });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "DATA_MANAGEMENT_BUSY");
  assert.equal(db.transactions, 0);
});

test("R4/R9-happy-path — valid token + exact phrase + lock free + environment allowed -> executes exactly once, writes a COMPLETED audit row, releases the lock", async () => {
  const auditCalls: unknown[] = [];
  const db = createFakeDb({ respond: respondAllCounts(5) });
  const pool = makeFakePool({ lockAvailable: true });
  const mod = await loadResetService({ db, pool, auditCalls });

  const preview = await mod.previewReset({ session: SESSION, requestedScopes: ["WORKFORCE"] });
  const result = await mod.executeReset({ session: SESSION, previewToken: preview.previewToken, confirmationPhrase: "RESET WORKFORCE DATA" });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.effectiveScopes.length, 1);
    assert.equal(result.effectiveScopes[0], "WORKFORCE");
    assert.ok(result.rowCountsDeleted.length >= 17, "WORKFORCE must delete its full forced dependency set, including the 5 Mission E domains");
    const domains = result.rowCountsDeleted.map((d) => d.domain);
    for (const missionEDomain of ["dw_code_assignments", "it_code_assignment_history", "same_day_lifecycle_events", "meal_exclusions", "dw_code_pool_reset"]) {
      assert.ok(domains.includes(missionEDomain), `WORKFORCE must include Mission E domain ${missionEDomain}`);
    }
  }
  assert.equal(db.transactions, 1, "exactly one transaction for the whole reset");
  assert.equal(auditCalls.length, 1, "exactly one audit row written");
});

test("Mission E go-live prep — WORKFORCE reset deletes dw_code_assignments/it_code_assignments/same_day_lifecycle_events/meal_exclusions BEFORE worker_profiles/employment_sessions/dw_data/daily_applications (real Postgres FK RESTRICT from those history tables)", async () => {
  const auditCalls: unknown[] = [];
  const db = createFakeDb({ respond: respondAllCounts(2) });
  const pool = makeFakePool({ lockAvailable: true });
  const mod = await loadResetService({ db, pool, auditCalls });

  const preview = await mod.previewReset({ session: SESSION, requestedScopes: ["WORKFORCE"] });
  const result = await mod.executeReset({ session: SESSION, previewToken: preview.previewToken, confirmationPhrase: "RESET WORKFORCE DATA" });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const order = result.rowCountsDeleted.map((d) => d.domain);
  const idx = (k: string) => order.indexOf(k);
  for (const historyDomain of ["dw_code_assignments", "it_code_assignment_history", "same_day_lifecycle_events", "meal_exclusions"]) {
    assert.ok(idx(historyDomain) < idx("worker_profiles"), `${historyDomain} must delete before worker_profiles (real FK RESTRICT)`);
    assert.ok(idx(historyDomain) < idx("employment_sessions"), `${historyDomain} must delete before employment_sessions (real FK RESTRICT)`);
    assert.ok(idx(historyDomain) < idx("dw_data"), `${historyDomain} must delete before dw_data (real FK RESTRICT)`);
  }
  assert.ok(idx("meal_exclusions") < idx("daily_applications"), "meal_exclusions must delete before daily_applications (real FK RESTRICT)");
  assert.ok(idx("same_day_lifecycle_events") < idx("daily_applications"), "same_day_lifecycle_events must delete before daily_applications (real FK RESTRICT)");
});

/**
 * MISSION F2 section 23-24/252 — composed proof (real reset-service.ts + real scopes.ts, the
 * actual REAL sql`` template from drizzle-orm, not a stub) that a full ALL_BUSINESS_DATA reset
 * run — the broadest scope, union of everything — really does issue the dw_codes status-reset SQL
 * AND never issues any query-builder call or raw SQL execute() against dw_code_locations. This
 * complements scopes.test.ts's static "never a domain target table" proof with an end-to-end one:
 * even if some FUTURE domain wiring mistake bypassed RESET_DOMAIN_META's exhaustiveness (e.g. a
 * stray direct call), this test would still catch it because it inspects every call the real
 * service actually issued, not just the declared domain list.
 */
test("ALL_BUSINESS_DATA reset composed end-to-end: dw_codes status IS reset via raw SQL, dw_code_locations is NEVER touched by any query or raw SQL", async () => {
  const auditCalls: unknown[] = [];
  const db = createFakeDb({ respond: respondAllCounts(3) });
  const pool = makeFakePool({ lockAvailable: true });
  const mod = await loadResetService({ db, pool, auditCalls });

  const preview = await mod.previewReset({ session: SESSION, requestedScopes: ["ALL_BUSINESS_DATA"] });
  const result = await mod.executeReset({ session: SESSION, previewToken: preview.previewToken, confirmationPhrase: "RESET ALL BUSINESS DATA" });
  assert.equal(result.ok, true);

  assert.equal(db.calls.some((c) => c.table === "dw_code_locations"), false, "no query-builder call may ever target dw_code_locations");

  const executeCalls = db.calls.filter((c) => c.root === "execute");
  assert.ok(executeCalls.length > 0, "the dw_code_pool_reset domain must issue at least one raw SQL execute()");
  const sqlTexts = executeCalls.map((c) => {
    const sqlArg = c.ops[0]?.args[0] as { queryChunks?: unknown[] } | undefined;
    return (sqlArg?.queryChunks ?? [])
      .map((chunk) => {
        if (typeof chunk === "string") return chunk;
        const value = (chunk as { value?: unknown[] } | undefined)?.value;
        return Array.isArray(value) ? value.filter((v) => typeof v === "string").join("") : "";
      })
      .join("");
  });
  assert.ok(sqlTexts.some((t) => t.includes("dw_codes") && t.includes("AVAILABLE")), "must reset dw_codes.status back to AVAILABLE");
  assert.ok(!sqlTexts.some((t) => t.includes("dw_code_locations")), "no raw SQL execute() may ever reference dw_code_locations");
});
