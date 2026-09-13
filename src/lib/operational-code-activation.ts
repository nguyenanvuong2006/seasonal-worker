import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { buildActivationPlan, type ActivationPlan, type LocationRow, type DwLegacyRow, type ItMirrorRow } from "@/lib/operational-code-activation-plan";

export * from "@/lib/operational-code-activation-plan";

/**
 * MISSION F — OPERATIONAL CODE GO-LIVE PREPARATION (sections 3, 9-12, 23-26).
 * ------------------------------------------------------------------------
 * READ-ONLY dry-run planner. `prepareOperationalCodeActivation()` never
 * writes anything — it computes what an eventual adoption/activation WOULD
 * do, so an owner can review the plan (and its checksum) before any real
 * Production write happens. The pure plan-assembly logic (parseDwCodeFormat,
 * buildActivationPlan, etc.) lives in operational-code-activation-plan.ts —
 * split out so a standalone script (scripts/run-operational-code-activation-
 * dryrun.mjs) can reuse the EXACT SAME planning logic against Production
 * without needing this module's "server-only"/"@/db" imports (see that
 * file's own docblock for why "server-only" cannot be imported outside a
 * Next.js server bundle).
 *
 * `applyOperationalCodeActivation()` is DELIBERATELY NOT IMPLEMENTED in this
 * mission (section 25: "Design but DO NOT execute" / "ACTIVATION WRITE MUST
 * BE SEPARATE") — it always throws. Its required contract (advisory lock,
 * planChecksum freshness check, re-check conflicts, staged transaction,
 * idempotent, audit) is documented on the function below so a FUTURE,
 * explicitly-authorized mission can implement it against this same plan
 * shape without re-deriving the contract. This mission's own ABSOLUTE
 * SAFETY section forbids any Production DW/IT code assignment or release —
 * an unreachable-but-designed function is the correct scope, not a
 * real-but-never-called one (nothing in this codebase wires it to any
 * route/button, so it cannot be triggered even accidentally).
 *
 * BOOTSTRAP SAFETY (section 3, the P1 this whole planner exists for): the
 * canonical pool (dw_codes/dw_code_assignments) starts EMPTY. Every DW Code
 * a worker holds today came from the legacy free-text `dw_data.code` field
 * (see src/app/api/administration/daily-code/route.ts), completely
 * unknown to allocateDwCode()'s reuse/sequence logic. Activating the pool
 * allocator for a location whose `nextSequence` is still at its schema
 * default (1) while legacy codes like DR00001-D..DR01482-D are already in
 * active use would let `allocateDwCode()` issue DR00001-D again — this
 * planner's `locationReadiness[].state` (`SEQUENCE_UNSAFE`) and the
 * companion fail-closed guard in dw-code-locations-admin.ts's
 * `createDwCodeLocation()` (mission section 41 fix) are what actually
 * prevent that, not merely report it.
 */

type Executor = typeof db;

/** dryRun is required and must be true — this function performs ONLY SELECT statements
 * regardless, but the flag is kept explicit in the call site per mission section 9/23
 * ("prepareOperationalCodeActivation({ dryRun: true })") so no future edit can silently
 * turn this into a writer without a visible signature change. */
export async function prepareOperationalCodeActivation(options: { dryRun: true }, executor: Executor = db): Promise<ActivationPlan> {
  if (!options.dryRun) throw new Error("prepareOperationalCodeActivation: dryRun must be true — this function never writes.");

  const locationsResult = await executor.execute<{ location_id: string; prefix: string; name: string; is_active: boolean; next_sequence: number }>(
    sql`SELECT id AS location_id, prefix, name, is_active, next_sequence FROM dw_code_locations`,
  );
  const locations: LocationRow[] = locationsResult.rows.map((r) => ({ locationId: r.location_id, prefix: r.prefix, name: r.name, isActive: r.is_active, nextSequence: r.next_sequence }));

  const dwResult = await executor.execute<{ dw_data_id: string; worker_ref: string | null; employment_session_id: string | null; code: string; is_active: boolean }>(sql`
    SELECT d.id AS dw_data_id, wp.id AS worker_ref, es.id AS employment_session_id, d.code AS code,
           COALESCE(es.status = 'APPROVED' AND es.end_date IS NULL, false) AS is_active
    FROM dw_data d
    LEFT JOIN worker_profiles wp ON wp.cccd = d.cccd AND wp.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT id, status, end_date FROM employment_sessions
      WHERE worker_id = wp.id
      ORDER BY (status = 'APPROVED' AND end_date IS NULL) DESC, reg_date DESC
      LIMIT 1
    ) es ON true
    WHERE d.code IS NOT NULL AND trim(d.code) <> '' AND d.deleted_at IS NULL
  `);
  const dwRows: DwLegacyRow[] = dwResult.rows.map((r) => ({ dwDataId: r.dw_data_id, workerRef: r.worker_ref, employmentSessionId: r.employment_session_id, code: r.code, isActive: r.is_active }));

  const itResult = await executor.execute<{
    worker_ref: string;
    dw_data_id: string | null;
    employment_session_id: string | null;
    dw_it_code: string | null;
    wp_fingerprint_code: string | null;
    is_active: boolean;
  }>(sql`
    SELECT wp.id AS worker_ref, d.id AS dw_data_id, es.id AS employment_session_id,
           d.it_code AS dw_it_code, wp.fingerprint_code AS wp_fingerprint_code,
           COALESCE(es.status = 'APPROVED' AND es.end_date IS NULL, false) AS is_active
    FROM worker_profiles wp
    LEFT JOIN dw_data d ON d.cccd = wp.cccd AND d.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT id, status, end_date FROM employment_sessions
      WHERE worker_id = wp.id
      ORDER BY (status = 'APPROVED' AND end_date IS NULL) DESC, reg_date DESC
      LIMIT 1
    ) es ON true
    WHERE wp.deleted_at IS NULL AND (wp.fingerprint_code IS NOT NULL OR d.it_code IS NOT NULL)
  `);
  const itRows: ItMirrorRow[] = itResult.rows.map((r) => ({ workerRef: r.worker_ref, dwDataId: r.dw_data_id, employmentSessionId: r.employment_session_id, dwDataItCode: r.dw_it_code, workerProfileFingerprintCode: r.wp_fingerprint_code, isActive: r.is_active }));

  return buildActivationPlan({
    generatedAt: new Date().toISOString(),
    sourceCommitSha: process.env.APP_COMMIT_SHA ?? null,
    locations,
    dwRows,
    itRows,
  });
}

/**
 * NOT IMPLEMENTED (mission section 25 — "Design but DO NOT execute"). Documented contract for a
 * FUTURE, separately-authorized mission:
 *
 *   1. Recompute prepareOperationalCodeActivation({ dryRun: true }) fresh and compare its
 *      `.checksum` to `planChecksum` — mismatch => reject ACTIVATION_PLAN_STALE, do nothing.
 *   2. Reject if the fresh plan has any `conflicts[]` (section 11 — "Do not automatically fix
 *      Production conflicts") or any non-READY/INACTIVE `locationReadiness[]` entry.
 *   3. Take a DEDICATED Postgres advisory lock (a new key, never reused from
 *      DATA_MANAGEMENT_ADVISORY_LOCK_KEY in reset-service.ts — activation and reset are
 *      different risk domains and must never serialize on each other's lock).
 *   4. In one transaction, in the exact order from section 26: (a) INSERT the protected legacy
 *      codes as `dw_codes` rows with status='RETIRED' (ON CONFLICT (code) DO NOTHING — idempotent);
 *      (b) UPDATE each touched `dw_code_locations.next_sequence` to at least
 *      computeSafeNextSequence(legacyObservedMaxSequence); (c) for each `dwAdoptions[]` entry,
 *      INSERT a `dw_codes` ASSIGNED row + a `dw_code_assignments` row (never touch the
 *      `dw_data.code` mirror — it is already correct, this is adoption of EXISTING state, not
 *      reassignment); (d) for each `itAdoptions[]` entry, INSERT an `it_code_assignments` row
 *      (same non-mutation-of-mirrors principle).
 *   5. Release the lock, write ONE audit row summarizing counts (never raw CCCD/phone).
 *   6. Idempotent: re-running with the SAME already-applied plan checksum after a first
 *      successful apply should be a safe no-op (the ON CONFLICT / already-exists checks in step 4
 *      make every sub-operation individually idempotent).
 *
 * This function intentionally throws so it can exist in the codebase (satisfying "code changes"
 * from the mission's ABSOLUTE SAFETY allow-list) without being callable — there is also no
 * route/UI button anywhere in this PR that invokes it.
 *
 * ACTIVATION STATE (mission section 20-22/253) — DISABLED, never SHADOW or ACTIVE. This is not a
 * runtime flag that could be flipped by mistake — there IS no mode variable, because there is no
 * callable path at all: `grep -r "applyOperationalCodeActivation\|prepareOperationalCodeActivation"
 * src/app` returns zero matches (2026-09-13) — no API route, no server action, no admin UI button
 * anywhere in the application surface calls either function. `applyOperationalCodeActivation()`
 * itself always throws regardless. Fail-closed is structural, not configurable: there is nothing
 * to disable because nothing was ever wired to be enabled.
 */
export async function applyOperationalCodeActivation(_planChecksum: string): Promise<never> {
  throw new Error(
    "applyOperationalCodeActivation: NOT IMPLEMENTED in this mission. Production DW/IT code assignment is not authorized here — see this function's docblock for the required contract for a future, separately-authorized rollout.",
  );
}
