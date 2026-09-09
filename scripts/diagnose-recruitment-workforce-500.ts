/**
 * READ-ONLY diagnosis (2026-09, Production incident): "Recruitment Requests"
 * list returns HTTP 500, "Workforce Request" page fails to parse an empty/
 * non-JSON response.
 *
 * Both `listRecruitmentRequests()` (recruitment-request.ts) and
 * `listWorkforceRequests()`/`getRequestDashboard()` (workforce-request.ts)
 * do a FULL-ROW select on `recruitmentRequests` (`db.select().from(...)` or
 * `select({ request: recruitmentRequests, ... })`), plus several joins.
 * Production migrations for these tables are NOT run by any CI workflow
 * (see docs/PRODUCTION-DEPLOY.md — only Document Merge migrations are
 * automated; everything else is `psql -f migrations/<file>.sql` run BY
 * HAND). A migration file added to the repo but never manually applied to
 * Production would leave code (Drizzle schema.ts) referencing a column
 * that plain doesn't exist there — Postgres error 42703
 * (undefined_column) — matching a full-page HTTP 500 for GET requests
 * that do `SELECT *`-equivalent.
 *
 * This script:
 *   1) Compares Drizzle's expected columns for every table referenced by
 *      the two failing code paths against real information_schema.columns
 *      in the CONNECTED database — surfaces exactly which column(s), if
 *      any, are missing (or extra) WITHOUT guessing from source alone.
 *   2) Directly invokes the REAL service functions
 *      (listRecruitmentRequests / listWorkforceRequests /
 *      getRequestDashboard) with an unrestricted scope, capturing the
 *      real Postgres error class/code/message (never secrets/PII) if one
 *      is thrown — the same code path Production's routes execute.
 *
 * SAFETY: zero writes. Only SELECTs (information_schema + the tables
 * these read paths already read). No PII printed — only counts and
 * structural facts.
 *
 * Cách dùng:
 *   DATABASE_URL=... node --import tsx scripts/diagnose-recruitment-workforce-500.ts
 */
import { getTableColumns } from "drizzle-orm";
import { pool } from "../src/db/index.ts";
import {
  recruitmentRequests,
  departments,
  planningPeriods,
  employmentSessions,
  workerProfiles,
  workforceMovements,
  dailyApplications,
  requestAllocations,
  requestAllocationHistory,
  requestAllocationOverrides,
  requestComments,
  requestKpiCache,
} from "../src/db/schema.ts";
import { listRecruitmentRequests } from "../src/lib/recruitment-request.ts";
import { listWorkforceRequests, getRequestDashboard } from "../src/lib/workforce-request.ts";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

const TABLES: { label: string; table: unknown }[] = [
  { label: "recruitment_requests", table: recruitmentRequests },
  { label: "departments", table: departments },
  { label: "planning_periods", table: planningPeriods },
  { label: "employment_sessions", table: employmentSessions },
  { label: "worker_profiles", table: workerProfiles },
  { label: "workforce_movements", table: workforceMovements },
  { label: "daily_applications", table: dailyApplications },
  { label: "request_allocations", table: requestAllocations },
  { label: "request_allocation_history", table: requestAllocationHistory },
  { label: "request_allocation_overrides", table: requestAllocationOverrides },
  { label: "request_comments", table: requestComments },
  { label: "request_kpi_cache", table: requestKpiCache },
];

async function checkTableColumns(dbTableName: string, expectedTable: unknown) {
  const { rows: existsRows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS exists`,
    [dbTableName],
  );
  if (!existsRows[0]?.exists) {
    log("TABLE_MISSING", { table: dbTableName });
    return;
  }

  const { rows: actualRows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [dbTableName],
  );
  const actualColumns = new Set(actualRows.map((r) => r.column_name));

  const expectedColumns = getTableColumns(expectedTable as never);
  const missing: string[] = [];
  for (const [, col] of Object.entries(expectedColumns)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbName = (col as any).name as string;
    if (!actualColumns.has(dbName)) missing.push(dbName);
  }

  log("TABLE_COLUMN_CHECK", {
    table: dbTableName,
    expectedColumnCount: Object.keys(expectedColumns).length,
    actualColumnCount: actualColumns.size,
    missingColumns: missing,
  });
}

async function tryRealQuery(label: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    const count = Array.isArray(result)
      ? result.length
      : result && typeof result === "object" && "rows" in (result as Record<string, unknown>)
        ? (result as { rows: unknown[] }).rows.length
        : "n/a";
    log("QUERY_OK", { label, resultCount: count });
  } catch (error) {
    const err = error as { name?: string; message?: string; code?: string };
    log("QUERY_FAILED", {
      label,
      errorName: err?.name ?? null,
      errorCode: err?.code ?? null, // Postgres SQLSTATE, e.g. 42703 = undefined_column
      errorMessage: err?.message ? err.message.slice(0, 500) : null,
    });
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  log("PHASE_1_STRUCTURAL_COLUMN_CHECK_START");
  for (const { label, table } of TABLES) {
    try {
      await checkTableColumns(label, table);
    } catch (error) {
      log("TABLE_CHECK_ERROR", { table: label, message: (error as Error).message.slice(0, 300) });
    }
  }

  log("PHASE_2_REAL_QUERY_EXECUTION_START");
  await tryRealQuery("listRecruitmentRequests(scope=null)", () => listRecruitmentRequests({ scope: null }, 1, 0));
  await tryRealQuery("listWorkforceRequests(scope=null)", () => listWorkforceRequests({ scope: null, limit: 1 }));
  await tryRealQuery("getRequestDashboard(scope=null)", () => getRequestDashboard(null));

  await pool.end();
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "fatal_error", error: error instanceof Error ? error.message.slice(0, 500) : String(error) }));
  process.exit(1);
});
