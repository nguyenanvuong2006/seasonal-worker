import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { buildActivationPlan, computePlanContentChecksum, type ActivationPlan, type LocationRow, type DwLegacyRow, type ItMirrorRow } from "@/lib/operational-code-activation-plan";

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
 * `applyOperationalCodeActivation()` is the writer — see its own docblock.
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

// ---- Executor types ----
// The dry-run wrapper only needs SELECT (execute). The writer needs a full
// transaction handle — we accept both via a duck-typed interface so tests
// can substitute a fake without importing Drizzle internals.
// Note: the real db.execute() accepts SQLWrapper | string; we use `unknown` here for
// test-fake compatibility, and cast `db` at the call site.
type SelectExecutor = { execute: <T>(query: unknown) => Promise<{ rows: T[] }> };
type TransactionHandle = SelectExecutor & { execute: <T>(query: unknown) => Promise<{ rows: T[] } | { rowCount?: number }> };
type DbExecutor = SelectExecutor & { transaction?: <T>(fn: (tx: TransactionHandle) => Promise<T>) => Promise<T> };

/** dryRun is required and must be true — this function performs ONLY SELECT statements
 * regardless, but the flag is kept explicit in the call site per mission section 9/23
 * ("prepareOperationalCodeActivation({ dryRun: true })") so no future edit can silently
 * turn this into a writer without a visible signature change. */
export async function prepareOperationalCodeActivation(options: { dryRun: true }, executor: SelectExecutor = db as unknown as SelectExecutor): Promise<ActivationPlan> {
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

// ---------------------------------------------------------------------------
// ADVISORY LOCK
// ---------------------------------------------------------------------------
// A NEW key, deliberately distinct from DATA_MANAGEMENT_ADVISORY_LOCK_KEY
// (847_291_003 in reset-service.ts). Activation and data-reset are different
// risk domains and must NEVER serialize on the same lock — an activation
// running concurrently with a reset would be catastrophic regardless of which
// one "wins", so we want them to see each other as separate risk domains and
// fail independently, not to silently queue behind each other.
//
// We use pg_try_advisory_xact_lock (transaction-level) instead of the
// session-level lock in reset-service.ts because:
//   1. The entire write is a single transaction — automatic release on
//      commit or rollback, no try/finally needed.
//   2. Transaction-level advisory locks cannot be taken more than once per
//      transaction (any second call is a NOOP from Postgres's perspective
//      for xact locks), which is the correct idempotency behaviour here.
export const OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY = 847_291_004;

// ---------------------------------------------------------------------------
// RESULT TYPE
// ---------------------------------------------------------------------------
export type ApplyActivationResult = {
  ok: true;
  checksum: string;
  protectedDwCount: number;
  adoptedDwCount: number;
  adoptedItCount: number;
  skippedDwCount: number;
  skippedItCount: number;
};

// ---------------------------------------------------------------------------
// WRITER
// ---------------------------------------------------------------------------
/**
 * Applies the operational code go-live plan produced by
 * `prepareOperationalCodeActivation({ dryRun: true })`.
 *
 * CONTRACT (mission section 26 / previously documented as NOT IMPLEMENTED):
 *
 *   1. Recomputes a fresh dry-run plan and verifies its checksum matches
 *      `planChecksum`. If not → throws ACTIVATION_PLAN_STALE (zero writes).
 *   2. Rejects if the fresh plan has conflicts or any non-READY/INACTIVE
 *      location — throws ACTIVATION_PLAN_NOT_READY (zero writes).
 *   3. Acquires a DEDICATED transaction-level advisory lock
 *      (OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY). Fails immediately
 *      if the lock is already held — throws ACTIVATION_LOCKED (zero writes).
 *   4. Performs ONE atomic transaction in the following exact order:
 *      A. Protected legacy DW codes → INSERT INTO dw_codes … status='RETIRED'
 *         ON CONFLICT (code) DO UPDATE SET status='RETIRED'
 *         WHERE dw_codes.status <> 'ASSIGNED'
 *         (idempotent; never downgrades ASSIGNED → RETIRED).
 *      B. Location nextSequence → UPDATE dw_code_locations SET
 *         next_sequence = GREATEST(next_sequence, safeValue).
 *      C. DW active adoption → upsert dw_codes as ASSIGNED + insert one
 *         dw_code_assignments history row (idempotent: skip if exact active
 *         assignment already exists; reject if code or worker already actively
 *         owned by another worker/session).
 *      D. IT active adoption → insert one it_code_assignments history row
 *         (idempotent: skip if exact active assignment exists; reject if
 *         conflicting active ownership).
 *      E. ONE aggregate audit_logs row (no CCCD, phone, name in payload).
 *   5. Idempotent: re-running with the same already-applied plan is a safe
 *      NOOP — duplicate assignment history rows are never created.
 *   6. Any failure inside the transaction rolls everything back.
 *
 * NOT wired to any API route or UI — must remain unrouted until a separate,
 * explicitly-authorized mission enables it (mission constraint: no route, no
 * button, no server action in this PR).
 */
export async function applyOperationalCodeActivation(
  planChecksum: string,
  /** Override the db executor — used by tests to inject a fake transaction runner. */
  _executor?: {
    transaction: (fn: (tx: TransactionHandle) => Promise<ApplyActivationResult>) => Promise<ApplyActivationResult>;
    execute: <T>(query: unknown) => Promise<{ rows: T[] }>;
  },
): Promise<ApplyActivationResult> {
  const executor = _executor ?? (db as unknown as typeof _executor)!;

  // ---- Step 1: Recompute fresh plan and check content checksum ----
  // We compare the CONTENT checksum (computePlanContentChecksum), not the full plan checksum —
  // because the full checksum includes `generatedAt` (which changes on every call), making the
  // freshness check impossible to satisfy across two separate calls. The content checksum covers
  // only the fields that determine what the activation would write (locationReadiness, dwAdoptions,
  // dwProtectedCodes, itAdoptions, conflicts, readiness), which is the correct staleness signal.
  const freshPlan = await prepareOperationalCodeActivation({ dryRun: true }, executor as SelectExecutor);
  const freshContentChecksum = computePlanContentChecksum(freshPlan);

  if (freshContentChecksum !== planChecksum) {
    throw new Error(
      `ACTIVATION_PLAN_STALE: supplied checksum ${planChecksum} does not match freshly-computed plan content checksum ${freshContentChecksum}. Re-run the dry-run to obtain the current content checksum.`,
    );
  }

  // ---- Step 2: Validate readiness ----
  if (freshPlan.readiness !== "READY_FOR_OPERATIONAL_CODE_ACTIVATION") {
    throw new Error(
      `ACTIVATION_PLAN_NOT_READY: fresh plan readiness is "${freshPlan.readiness}". Resolve all conflicts and location issues before applying.`,
    );
  }
  if (freshPlan.conflicts.length > 0) {
    throw new Error(
      `ACTIVATION_PLAN_NOT_READY: fresh plan has ${freshPlan.conflicts.length} conflict(s). Resolve before applying.`,
    );
  }
  const nonReadyLocation = freshPlan.locationReadiness.find((r) => r.state !== "READY" && r.state !== "INACTIVE");
  if (nonReadyLocation) {
    throw new Error(
      `ACTIVATION_PLAN_NOT_READY: location "${nonReadyLocation.name}" (${nonReadyLocation.prefix}) has state "${nonReadyLocation.state}". All locations must be READY or INACTIVE.`,
    );
  }
  // Validate no adoption row is ambiguous (all required fields present)
  for (const adoption of freshPlan.dwAdoptions) {
    if (!adoption.workerRef || !adoption.employmentSessionId || !adoption.dwDataId || !adoption.code || !adoption.locationId) {
      throw new Error(`ACTIVATION_PLAN_NOT_READY: DW adoption candidate for code "${adoption.code}" is incomplete.`);
    }
  }
  for (const adoption of freshPlan.itAdoptions) {
    if (!adoption.workerRef || !adoption.employmentSessionId || !adoption.dwDataId || !adoption.itCode) {
      throw new Error(`ACTIVATION_PLAN_NOT_READY: IT adoption candidate for worker "${adoption.workerRef}" is incomplete.`);
    }
  }

  // ---- Steps 3–5: Advisory lock + atomic transaction ----
  return await executor.transaction!(async (tx: TransactionHandle) => {
    // Step 3: Acquire transaction-level advisory lock (auto-releases on commit/rollback)
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY}) AS locked`,
    );
    const locked = (lockResult as { rows: { locked: boolean }[] }).rows[0]?.locked === true;
    if (!locked) {
      throw new Error("ACTIVATION_LOCKED: another operational code activation is already in progress. Try again later.");
    }

    // ---- Step 4A: Protected legacy DW codes → RETIRED ----
    // ON CONFLICT (code): update to RETIRED only if the row is not already ASSIGNED
    // (an ASSIGNED row means a previous adoption run already handled this code —
    // never downgrade ASSIGNED → RETIRED, which would break the active assignment).
    // Protected codes must NEVER become AVAILABLE.
    let protectedDwCount = 0;
    for (const prot of freshPlan.dwProtectedCodes) {
      await tx.execute(sql`
        INSERT INTO dw_codes (location_id, sequence_number, code, status)
        VALUES (${prot.locationId}, ${prot.sequenceNumber}, ${prot.code}, 'RETIRED')
        ON CONFLICT (code) DO UPDATE
          SET status = 'RETIRED'
          WHERE dw_codes.status = 'AVAILABLE'
      `);
      protectedDwCount++;
    }

    // ---- Step 4B: Location nextSequence — never decrease ----
    // For each location that has any legacy rows, bump next_sequence to at
    // least (legacyObservedMaxSequence + 1). GREATEST() guarantees monotonic.
    for (const locReadiness of freshPlan.locationReadiness) {
      if (locReadiness.state !== "READY" && locReadiness.state !== "INACTIVE") continue;
      const safeNext =
        locReadiness.legacyObservedMaxSequence !== null ? locReadiness.legacyObservedMaxSequence + 1 : locReadiness.nextSequence;
      if (safeNext <= locReadiness.nextSequence) continue; // already safe, no-op
      await tx.execute(sql`
        UPDATE dw_code_locations
        SET next_sequence = GREATEST(next_sequence, ${safeNext}),
            updated_at = now()
        WHERE id = ${locReadiness.locationId}
      `);
    }

    // ---- Step 4C: DW active adoption ----
    let adoptedDwCount = 0;
    let skippedDwCount = 0;

    for (const adoption of freshPlan.dwAdoptions) {
      // Upsert the dw_codes row (insert as ASSIGNED; if row exists with AVAILABLE set ASSIGNED;
      // if already ASSIGNED/RETIRED leave it alone — the assignment check below will handle skipping).
      await tx.execute(sql`
        INSERT INTO dw_codes (location_id, sequence_number, code, status)
        VALUES (${adoption.locationId}, ${adoption.sequenceNumber}, ${adoption.code}, 'ASSIGNED')
        ON CONFLICT (code) DO UPDATE
          SET status = 'ASSIGNED'
          WHERE dw_codes.status = 'AVAILABLE'
      `);

      // Retrieve the dw_codes.id for this code (needed for assignment FK).
      const codeRowResult = await tx.execute<{ id: string; status: string }>(
        sql`SELECT id, status FROM dw_codes WHERE code = ${adoption.code} LIMIT 1`,
      );
      const codeRow = (codeRowResult as { rows: { id: string; status: string }[] }).rows[0];
      if (!codeRow) throw new Error(`ACTIVATION_INTERNAL: dw_codes row for code "${adoption.code}" not found after upsert.`);

      // Check active assignment for this code.
      const existingByCodeResult = await tx.execute<{
        id: string;
        worker_id: string;
        employment_session_id: string;
      }>(
        sql`SELECT id, worker_id, employment_session_id FROM dw_code_assignments
            WHERE code_id = ${codeRow.id} AND released_at IS NULL
            LIMIT 1`,
      );
      const existingByCode = (existingByCodeResult as { rows: { id: string; worker_id: string; employment_session_id: string }[] }).rows[0];

      // Check active assignment for this worker.
      const existingByWorkerResult = await tx.execute<{
        id: string;
        worker_id: string;
        employment_session_id: string;
      }>(
        sql`SELECT id, worker_id, employment_session_id FROM dw_code_assignments
            WHERE worker_id = ${adoption.workerRef} AND released_at IS NULL
            LIMIT 1`,
      );
      const existingByWorker = (existingByWorkerResult as { rows: { id: string; worker_id: string; employment_session_id: string }[] }).rows[0];

      // Idempotency: if the EXACT active assignment already exists for this
      // code + worker + session, skip safely.
      if (
        existingByCode &&
        existingByCode.worker_id === adoption.workerRef &&
        existingByCode.employment_session_id === adoption.employmentSessionId
      ) {
        skippedDwCount++;
        continue;
      }

      // Reject conflicting active ownership on code.
      if (existingByCode) {
        throw new Error(
          `ACTIVATION_CONFLICT: DW Code "${adoption.code}" already has an active assignment to a different worker/session. Cannot reassign.`,
        );
      }

      // Reject conflicting active ownership on worker.
      if (existingByWorker) {
        throw new Error(
          `ACTIVATION_CONFLICT: Worker "${adoption.workerRef}" already has an active DW Code assignment. Cannot create a second one.`,
        );
      }

      // Insert the assignment history row.
      await tx.execute(sql`
        INSERT INTO dw_code_assignments
          (code_id, worker_id, employment_session_id, dw_data_id, assigned_by)
        VALUES
          (${codeRow.id}, ${adoption.workerRef}, ${adoption.employmentSessionId}, ${adoption.dwDataId}, 'SYSTEM_ACTIVATION')
      `);
      adoptedDwCount++;
    }

    // ---- Step 4D: IT active adoption ----
    let adoptedItCount = 0;
    let skippedItCount = 0;

    for (const adoption of freshPlan.itAdoptions) {
      // Check active assignment for this IT code.
      const existingByItCodeResult = await tx.execute<{
        id: string;
        worker_id: string;
        employment_session_id: string;
      }>(
        sql`SELECT id, worker_id, employment_session_id FROM it_code_assignments
            WHERE it_code = ${adoption.itCode} AND released_at IS NULL
            LIMIT 1`,
      );
      const existingByItCode = (existingByItCodeResult as { rows: { id: string; worker_id: string; employment_session_id: string }[] }).rows[0];

      // Check active assignment for this worker.
      const existingItByWorkerResult = await tx.execute<{
        id: string;
        worker_id: string;
        employment_session_id: string;
      }>(
        sql`SELECT id, worker_id, employment_session_id FROM it_code_assignments
            WHERE worker_id = ${adoption.workerRef} AND released_at IS NULL
            LIMIT 1`,
      );
      const existingItByWorker = (existingItByWorkerResult as { rows: { id: string; worker_id: string; employment_session_id: string }[] }).rows[0];

      // Idempotency: exact active assignment already exists — skip safely.
      if (
        existingByItCode &&
        existingByItCode.worker_id === adoption.workerRef &&
        existingByItCode.employment_session_id === adoption.employmentSessionId
      ) {
        skippedItCount++;
        continue;
      }

      // Reject conflicting active ownership on IT code.
      if (existingByItCode) {
        throw new Error(
          `ACTIVATION_CONFLICT: IT Code "${adoption.itCode}" already has an active assignment to a different worker/session.`,
        );
      }

      // Reject conflicting active ownership on worker.
      if (existingItByWorker) {
        throw new Error(
          `ACTIVATION_CONFLICT: Worker "${adoption.workerRef}" already has an active IT Code assignment. Cannot create a second one.`,
        );
      }

      // Insert the IT assignment history row.
      await tx.execute(sql`
        INSERT INTO it_code_assignments
          (it_code, worker_id, employment_session_id, dw_data_id, assigned_by)
        VALUES
          (${adoption.itCode}, ${adoption.workerRef}, ${adoption.employmentSessionId}, ${adoption.dwDataId}, 'SYSTEM_ACTIVATION')
      `);
      adoptedItCount++;
    }

    // ---- Step 4E: Aggregate audit log (no CCCD, phone, names, raw worker IDs) ----
    await tx.execute(sql`
      INSERT INTO audit_logs (action, target_type, category, details)
      VALUES (
        'OPERATIONAL_CODE_ACTIVATION',
        'OPERATIONAL_CODE',
        'SYSTEM',
        ${JSON.stringify({
          activationChecksum: planChecksum,
          protectedDwCount,
          adoptedDwCount,
          adoptedItCount,
          skippedDwCount,
          skippedItCount,
        })}::jsonb
      )
    `);

    return {
      ok: true,
      checksum: planChecksum,
      protectedDwCount,
      adoptedDwCount,
      adoptedItCount,
      skippedDwCount,
      skippedItCount,
    };
  });
}
