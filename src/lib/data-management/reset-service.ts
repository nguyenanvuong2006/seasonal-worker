import "server-only";
import type { PoolClient } from "pg";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "@/db";
import {
  requestAllocationOverrides,
  requestAllocationHistory,
  requestAllocations,
  requestComments,
  requestKpiCache,
  planningAllocations,
  startDateCorrections,
  workforceMovements,
  employmentSessions,
  dailyApplications,
  workerProfiles,
  dwData,
  planningTasks,
} from "@/db/schema";
import { writeAudit, type Session } from "@/lib/auth";
import { checkDataResetAllowed } from "./environment";
import { expandResetScopes, requiredConfirmationPhrase, RESET_PRESERVED_DOMAINS, type ResetScope, type ResetDomainKey, type ResetPlan } from "./scopes";
import { hashRowCounts, signResetPreviewToken, verifyResetPreviewToken } from "./preview-token";

/**
 * WORKFORCE DATA MANAGEMENT — reset preview/execute (mission sections 5, 9-12).
 * Two entry points: previewReset() (read-only, mints a bound token) and
 * executeReset() (verifies token + confirmation phrase + environment guard +
 * advisory lock, then deletes/nulls in the canonical dependency order inside
 * one transaction). No direct "reset now, no preview" path exists — execute
 * requires a token that only preview can mint.
 */

// One well-known advisory lock key for the whole feature — cross-request
// mutual exclusion for ANY destructive data-management operation (reset OR
// import execute), not per-scope. Simpler and safer than per-scope locks:
// an IT Code reset racing a Workforce import is exactly as unsafe as two
// Workforce resets racing each other.
export const DATA_MANAGEMENT_ADVISORY_LOCK_KEY = 847_291_003;

export type RowCountEntry = { domain: string; table: string; label: string; rows: number };

export type ResetPreviewResult = {
  requestedScopes: ResetScope[];
  effectiveScopes: ResetScope[];
  affected: RowCountEntry[];
  preserved: readonly string[];
  warnings: string[];
  destructive: true;
  requiredConfirmationPhrase: string;
  previewToken: string;
  expiresAt: string;
};

async function countDomainRows(domain: ResetDomainKey): Promise<number> {
  switch (domain) {
    case "request_allocation_overrides":
      return countAll(requestAllocationOverrides);
    case "request_allocation_history":
      return countAll(requestAllocationHistory);
    case "request_allocations":
      return countAll(requestAllocations);
    case "request_comments":
      return countAll(requestComments);
    case "request_kpi_cache":
      return countAll(requestKpiCache);
    case "planning_allocations":
      return countAll(planningAllocations);
    case "start_date_corrections":
      return countAll(startDateCorrections);
    case "workforce_movements":
      return countAll(workforceMovements);
    case "employment_sessions":
      return countAll(employmentSessions);
    case "daily_applications":
      return countAll(dailyApplications);
    case "worker_profiles":
      return countAll(workerProfiles);
    case "dw_data":
      return countAll(dwData);
    case "planning_tasks":
      return countAll(planningTasks);
    case "it_code_worker_profiles": {
      const result = await db.execute<{ c: string }>(sql`SELECT count(*)::text AS c FROM worker_profiles WHERE fingerprint_code IS NOT NULL OR fingerprint_status IS DISTINCT FROM 'CHUA_CAP'`);
      return Number(result.rows[0]?.c ?? 0);
    }
    case "it_code_dw_data": {
      const result = await db.execute<{ c: string }>(sql`SELECT count(*)::text AS c FROM dw_data WHERE it_code IS NOT NULL`);
      return Number(result.rows[0]?.c ?? 0);
    }
    case "it_code_daily_applications": {
      const result = await db.execute<{ c: string }>(sql`SELECT count(*)::text AS c FROM daily_applications WHERE it_code IS NOT NULL`);
      return Number(result.rows[0]?.c ?? 0);
    }
  }
}

async function countAll(table: { $inferSelect: unknown }): Promise<number> {
  const [row] = await db.select({ c: sql<number>`count(*)` }).from(table as never);
  return Number((row as { c: number } | undefined)?.c ?? 0);
}

export type PreviewResetInput = { session: Session; requestedScopes: ResetScope[] };

export async function previewReset({ session, requestedScopes }: PreviewResetInput): Promise<ResetPreviewResult> {
  const guard = checkDataResetAllowed();
  const plan = expandResetScopes(requestedScopes);

  const affected: RowCountEntry[] = [];
  for (const domain of plan.domains) {
    const rows = await countDomainRows(domain.key);
    affected.push({ domain: domain.key, table: domain.table, label: domain.label, rows });
  }

  const warnings: string[] = [];
  if (!guard.allowed) warnings.push(guard.reason);
  if (plan.domains.length === 0) warnings.push("Không có phạm vi hợp lệ nào được chọn.");

  const countsHash = hashRowCounts(affected.map((a) => ({ domain: a.domain, rows: a.rows })));
  const { token, expiresAt } = await signResetPreviewToken({
    actor: session.username,
    requestedScopes: plan.requestedScopes,
    effectiveScopes: plan.effectiveScopes,
    environment: guard.environment,
    countsHash,
  });

  return {
    requestedScopes: plan.requestedScopes,
    effectiveScopes: plan.effectiveScopes,
    affected,
    preserved: RESET_PRESERVED_DOMAINS,
    warnings,
    destructive: true,
    requiredConfirmationPhrase: requiredConfirmationPhrase(plan.effectiveScopes),
    previewToken: token,
    expiresAt,
  };
}

export type ExecuteResetInput = { session: Session; previewToken: string; confirmationPhrase: string };

export type ExecuteResetError =
  | { code: "DATA_RESET_DISABLED"; message: string }
  | { code: "RESET_PREVIEW_EXPIRED"; message: string }
  | { code: "RESET_PLAN_CHANGED"; message: string }
  | { code: "INVALID_CONFIRMATION"; message: string }
  | { code: "DATA_MANAGEMENT_BUSY"; message: string };

export type ExecuteResetResult = { ok: true; effectiveScopes: ResetScope[]; rowCountsDeleted: RowCountEntry[]; operationId: string } | { ok: false; error: ExecuteResetError };

async function deleteDomain(tx: typeof db, domain: ResetDomainKey): Promise<number> {
  switch (domain) {
    case "request_allocation_overrides":
      return deleteAll(tx, requestAllocationOverrides);
    case "request_allocation_history":
      return deleteAll(tx, requestAllocationHistory);
    case "request_allocations":
      return deleteAll(tx, requestAllocations);
    case "request_comments":
      return deleteAll(tx, requestComments);
    case "request_kpi_cache":
      return deleteAll(tx, requestKpiCache);
    case "planning_allocations":
      return deleteAll(tx, planningAllocations);
    case "start_date_corrections":
      return deleteAll(tx, startDateCorrections);
    case "workforce_movements":
      return deleteAll(tx, workforceMovements);
    case "employment_sessions":
      return deleteAll(tx, employmentSessions);
    case "daily_applications":
      return deleteAll(tx, dailyApplications);
    case "worker_profiles":
      return deleteAll(tx, workerProfiles);
    case "dw_data":
      return deleteAll(tx, dwData);
    case "planning_tasks":
      return deleteAll(tx, planningTasks);
    case "it_code_worker_profiles": {
      const res = await tx.execute(sql`UPDATE worker_profiles SET fingerprint_code = NULL, fingerprint_device = NULL, fingerprint_status = 'CHUA_CAP', fingerprint_created_at = NULL, fingerprint_last_used_at = NULL, updated_at = now()`);
      return (res as { rowCount?: number }).rowCount ?? 0;
    }
    case "it_code_dw_data": {
      const res = await tx.execute(sql`UPDATE dw_data SET it_code = NULL, it_code_updated_at = NULL, it_code_updated_by = NULL WHERE it_code IS NOT NULL`);
      return (res as { rowCount?: number }).rowCount ?? 0;
    }
    case "it_code_daily_applications": {
      const res = await tx.execute(sql`UPDATE daily_applications SET it_code = NULL, updated_at = now() WHERE it_code IS NOT NULL`);
      return (res as { rowCount?: number }).rowCount ?? 0;
    }
  }
}

async function deleteAll(tx: typeof db, table: Parameters<typeof db.delete>[0]): Promise<number> {
  const res = await tx.delete(table);
  return (res as { rowCount?: number }).rowCount ?? 0;
}

/** Best-effort cross-request lock via a session-scoped Postgres advisory lock (mission section 11). Returns false immediately (never blocks) if another data-management operation already holds it. */
export async function tryAcquireDataManagementLock(): Promise<boolean> {
  const client: PoolClient = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [DATA_MANAGEMENT_ADVISORY_LOCK_KEY]);
    const locked = rows[0]?.locked === true;
    if (!locked) client.release();
    else lockedClients.add(client);
    return locked;
  } catch (err) {
    client.release();
    throw err;
  }
}

// Advisory locks are SESSION-scoped in Postgres — the connection that took the
// lock must be the one that releases it (or simply be closed/returned in a
// state that drops the lock). We keep the exact client around for the
// duration of the operation and release the lock (then the client) when done.
const lockedClients = new Set<PoolClient>();

export async function releaseDataManagementLock(): Promise<void> {
  for (const client of lockedClients) {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [DATA_MANAGEMENT_ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
      lockedClients.delete(client);
    }
  }
}

export async function executeReset({ session, previewToken, confirmationPhrase }: ExecuteResetInput): Promise<ExecuteResetResult> {
  const guard = checkDataResetAllowed();
  if (!guard.allowed) {
    return { ok: false, error: { code: "DATA_RESET_DISABLED", message: guard.reason } };
  }

  const verified = await verifyResetPreviewToken(previewToken);
  if (!verified.ok) {
    return {
      ok: false,
      error: verified.reason === "EXPIRED" ? { code: "RESET_PREVIEW_EXPIRED", message: "Preview đã hết hạn — hãy tạo preview mới." } : { code: "RESET_PREVIEW_EXPIRED", message: "Preview token không hợp lệ." },
    };
  }

  const expected = requiredConfirmationPhrase(verified.payload.effectiveScopes);
  if (confirmationPhrase.trim() !== expected) {
    return { ok: false, error: { code: "INVALID_CONFIRMATION", message: `Bạn phải gõ đúng: ${expected}` } };
  }

  const plan: ResetPlan = expandResetScopes(verified.payload.effectiveScopes);
  const currentCounts: RowCountEntry[] = [];
  for (const domain of plan.domains) {
    const rows = await countDomainRows(domain.key);
    currentCounts.push({ domain: domain.key, table: domain.table, label: domain.label, rows });
  }
  const currentHash = hashRowCounts(currentCounts.map((c) => ({ domain: c.domain, rows: c.rows })));
  if (currentHash !== verified.payload.countsHash) {
    return { ok: false, error: { code: "RESET_PLAN_CHANGED", message: "Dữ liệu đã thay đổi kể từ lúc xem trước — hãy tạo preview mới để đối chiếu lại số liệu." } };
  }

  const locked = await tryAcquireDataManagementLock();
  if (!locked) {
    return { ok: false, error: { code: "DATA_MANAGEMENT_BUSY", message: "Đang có thao tác Quản lý dữ liệu khác chạy — vui lòng thử lại sau." } };
  }

  const operationId = randomUUID();
  try {
    const rowCountsDeleted: RowCountEntry[] = [];
    await db.transaction(async (tx) => {
      for (const domain of plan.domains) {
        const deleted = await deleteDomain(tx as unknown as typeof db, domain.key);
        rowCountsDeleted.push({ domain: domain.key, table: domain.table, label: domain.label, rows: deleted });
      }
    });

    await writeAudit(session, "DATA_MANAGEMENT_RESET", "workforce_data", {
      operationId,
      operationType: "RESET",
      environment: guard.environment,
      requestedScopes: verified.payload.requestedScopes,
      effectiveScopes: plan.effectiveScopes,
      status: "COMPLETED",
      rowCountsBefore: currentCounts,
      rowCountsDeleted,
    }, "SYSTEM");

    return { ok: true, effectiveScopes: plan.effectiveScopes, rowCountsDeleted, operationId };
  } catch (error) {
    await writeAudit(session, "DATA_MANAGEMENT_RESET", "workforce_data", {
      operationId,
      operationType: "RESET",
      environment: guard.environment,
      requestedScopes: verified.payload.requestedScopes,
      effectiveScopes: plan.effectiveScopes,
      status: "FAILED",
      error: (error as Error).message,
    }, "SYSTEM");
    throw error;
  } finally {
    await releaseDataManagementLock();
  }
}
