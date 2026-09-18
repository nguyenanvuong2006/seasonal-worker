import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { buildActivationPlan, computePlanContentChecksum, type ActivationPlan, type LocationRow, type DwLegacyRow, type ItMirrorRow } from "@/lib/operational-code-activation-plan";
import { DATA_MANAGEMENT_ADVISORY_LOCK_KEY } from "@/lib/data-management/reset-service";

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
// ADVISORY LOCKS & CROSS-DOMAIN MUTUAL EXCLUSION
// ---------------------------------------------------------------------------
// To prevent concurrent activations AND exclude destructive data resets:
//   1. OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY (847_291_004):
//      Dedicated activation lock to serialize activations across requests.
//   2. SHARED_MAINTENANCE_EXCLUSION_ADVISORY_LOCK_KEY (847_291_003):
//      Shared with reset-service.ts (DATA_MANAGEMENT_ADVISORY_LOCK_KEY).
//
// In Postgres, advisory locks share the same key namespace regardless of
// whether acquired via session-level (pg_try_advisory_lock) or transaction-level
// (pg_try_advisory_xact_lock) calls. By acquiring BOTH locks inside the activation
// transaction:
//   - If a destructive data reset is running (holding 847_291_003), activation
//     fails closed immediately with ACTIVATION_LOCKED (never queues).
//   - While activation runs, any reset attempt calling tryAcquireDataManagementLock()
//     will fail with DATA_MANAGEMENT_BUSY.
//   - Zero mutations to operational-code tables can occur concurrently with reset.
export const OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY = 847_291_004;
export const SHARED_MAINTENANCE_EXCLUSION_ADVISORY_LOCK_KEY = DATA_MANAGEMENT_ADVISORY_LOCK_KEY;

// ---------------------------------------------------------------------------
// RESULT TYPE
// ---------------------------------------------------------------------------
export type ApplyActivationResult = {
  ok: true;
  activationContentChecksum: string;
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
 * CONTRACT (mission section 26 / PR #220 review blocker fixes / zero-TOCTOU):
 *
 *   1. Begins ONE atomic transaction BEFORE any recomputation, checksum comparison,
 *      or readiness validation.
 *   2. Acquires BOTH transaction-level advisory locks non-blocking inside the transaction:
 *      - Dedicated activation lock: OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY (847_291_004)
 *      - Shared maintenance lock: SHARED_MAINTENANCE_EXCLUSION_ADVISORY_LOCK_KEY (847_291_003)
 *      Fails closed immediately if either lock is held — throws ACTIVATION_LOCKED (zero writes).
 *   3. While both locks are held, calls `prepareOperationalCodeActivation({ dryRun: true }, tx)`
 *      using the SAME transaction executor (`tx`) that performs any subsequent writes.
 *   4. Compares supplied `activationContentChecksum` with `freshPlan.activationContentChecksum`
 *      INSIDE the locked transaction. If mismatch → throws ACTIVATION_PLAN_STALE (zero writes).
 *   5. Validates readiness, conflict count (0), location states (READY/INACTIVE),
 *      and adoption field completeness INSIDE the locked transaction.
 *      If invalid → throws ACTIVATION_PLAN_NOT_READY (zero writes).
 *   6. Performs atomic activation writes in the following exact order:
 *      A. Protected legacy DW codes → INSERT INTO dw_codes … status='RETIRED'
 *         ON CONFLICT (code) DO UPDATE SET status='RETIRED' WHERE dw_codes.status = 'AVAILABLE'
 *         (idempotent; protected codes that are not adoption candidates remain RETIRED).
 *      B. Location nextSequence → UPDATE dw_code_locations SET
 *         next_sequence = GREATEST(next_sequence, safeValue).
 *      C. DW active adoption → inspect existing dw_codes row and active ownership BEFORE mutation.
 *         Exact active assignment => safe skip; conflicting ownership => reject;
 *         valid adoption => ensure dw_codes.status = 'ASSIGNED' + insert dw_code_assignments
 *         (never leaves an active assignment attached to AVAILABLE or RETIRED).
 *      D. IT active adoption → insert one it_code_assignments history row
 *         (idempotent: skip if exact active assignment exists; reject if
 *         conflicting active ownership).
 *      E. ONE aggregate audit_logs row (no CCCD, phone, name in payload).
 *   7. Idempotent: re-running with the same already-applied plan is a safe
 *      NOOP — duplicate assignment history rows are never created.
 *   8. Any failure inside the transaction rolls everything back.
 *
 * NOT wired to any API route or UI — must remain unrouted until a separate,
 * explicitly-authorized mission enables it (mission constraint: no route, no
 * button, no server action in this PR).
 */
export async function applyOperationalCodeActivation(
  activationContentChecksum: string,
  /** Override the db executor — used by tests to inject a fake transaction runner. */
  _executor?: {
    transaction: (fn: (tx: TransactionHandle) => Promise<ApplyActivationResult>) => Promise<ApplyActivationResult>;
    execute: <T>(query: unknown) => Promise<{ rows: T[] }>;
  },
): Promise<ApplyActivationResult> {
  const executor = _executor ?? (db as unknown as typeof _executor)!;

  // ---- Atomic Transaction with Locked Freshness Validation (Zero-TOCTOU) ----
  // Freshness and readiness MUST be recomputed INSIDE the transaction, AFTER both
  // advisory locks have been acquired, using the SAME transaction executor (tx)
  // that executes any subsequent writes.
  return await executor.transaction!(async (tx: TransactionHandle) => {
    // Step 1: Acquire BOTH the dedicated activation lock AND the shared destructive-operation exclusion lock.
    // 1. Dedicated lock: OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY (847_291_004) serializes activation runs.
    // 2. Shared maintenance lock: SHARED_MAINTENANCE_EXCLUSION_ADVISORY_LOCK_KEY (847_291_003) mutually excludes
    //    destructive data-management operations (reset/import in reset-service.ts).
    // Both are transaction-level (pg_try_advisory_xact_lock) — auto-released on commit or rollback, fail-closed
    // immediately (never queue).
    const lockResult = await tx.execute<{
      activation_locked?: boolean;
      maintenance_locked?: boolean;
      locked?: boolean;
    }>(
      sql`SELECT
            pg_try_advisory_xact_lock(${OPERATIONAL_CODE_ACTIVATION_ADVISORY_LOCK_KEY}) AS activation_locked,
            pg_try_advisory_xact_lock(${SHARED_MAINTENANCE_EXCLUSION_ADVISORY_LOCK_KEY}) AS maintenance_locked`,
    );
    const lockRow = (lockResult as { rows: { activation_locked?: boolean; maintenance_locked?: boolean; locked?: boolean }[] }).rows[0];
    const actLocked = lockRow?.activation_locked ?? lockRow?.locked === true;
    if (!actLocked) {
      throw new Error("ACTIVATION_LOCKED: another operational code activation is already in progress. Try again later.");
    }
    const maintLocked = lockRow?.maintenance_locked ?? lockRow?.locked === true;
    if (!maintLocked) {
      throw new Error("ACTIVATION_LOCKED: a destructive data-management or reset operation is currently in progress. Try again later.");
    }

    // Step 2: Recompute fresh plan INSIDE the locked transaction using tx executor
    const freshPlan = await prepareOperationalCodeActivation({ dryRun: true }, tx as SelectExecutor);

    // Step 3: Compare supplied activationContentChecksum with fresh plan inside transaction
    if (freshPlan.activationContentChecksum !== activationContentChecksum) {
      throw new Error(
        `ACTIVATION_PLAN_STALE: supplied activationContentChecksum ${activationContentChecksum} does not match freshly-computed activationContentChecksum ${freshPlan.activationContentChecksum}. Re-run the dry-run to obtain the current activationContentChecksum.`,
      );
    }

    // Step 4: Validate readiness inside transaction
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

    // ---- Step 4A: Protected legacy DW codes → RETIRED ----
    // Bulk/set-based batch insertion (chunks of 500) to avoid 13k+ sequential round-trips (~42m -> ~4s).
    // ON CONFLICT (location_id, sequence_number): update to RETIRED only if the row is AVAILABLE.
    // (Protected codes that are not adoption candidates remain RETIRED).
    // Protected codes must NEVER become AVAILABLE.
    let protectedDwCount = 0;
    const PROTECTED_BATCH_SIZE = 500;
    for (let i = 0; i < freshPlan.dwProtectedCodes.length; i += PROTECTED_BATCH_SIZE) {
      const batch = freshPlan.dwProtectedCodes.slice(i, i + PROTECTED_BATCH_SIZE);
      const valueClauses = batch.map(
        (prot) => sql`(${prot.locationId}, ${prot.sequenceNumber}, ${prot.code}, 'RETIRED')`,
      );
      await tx.execute(sql`
        INSERT INTO dw_codes (location_id, sequence_number, code, status)
        VALUES ${sql.join(valueClauses, sql`, `)}
        ON CONFLICT (location_id, sequence_number) DO UPDATE
          SET status = 'RETIRED'
          WHERE dw_codes.status = 'AVAILABLE'
      `);
      protectedDwCount += batch.length;
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
      // 1. Inspect existing dw_codes row BEFORE final state mutation.
      // Match by code OR (location_id, sequence_number) so existing/protected rows are safely located
      // without duplicate sequence violations.
      const codeRowResult = await tx.execute<{
        id: string;
        status: string;
        code: string;
        location_id: string;
        sequence_number: number;
      }>(
        sql`SELECT id, status, code, location_id, sequence_number FROM dw_codes
            WHERE code = ${adoption.code}
               OR (location_id = ${adoption.locationId} AND sequence_number = ${adoption.sequenceNumber})
            LIMIT 1`,
      );
      const codeRow = (codeRowResult as { rows: { id: string; status: string; code: string; location_id: string; sequence_number: number }[] }).rows[0];

      // 2. Inspect active ownership BEFORE final state mutation
      let existingByCode: { id: string; worker_id: string; employment_session_id: string } | undefined;
      if (codeRow) {
        const existingByCodeResult = await tx.execute<{
          id: string;
          worker_id: string;
          employment_session_id: string;
        }>(
          sql`SELECT id, worker_id, employment_session_id FROM dw_code_assignments
              WHERE code_id = ${codeRow.id} AND released_at IS NULL
              LIMIT 1`,
        );
        existingByCode = (existingByCodeResult as { rows: { id: string; worker_id: string; employment_session_id: string }[] }).rows[0];
      }

      const existingByWorkerResult = await tx.execute<{
        id: string;
        code_id: string;
        worker_id: string;
        employment_session_id: string;
      }>(
        sql`SELECT id, code_id, worker_id, employment_session_id FROM dw_code_assignments
            WHERE worker_id = ${adoption.workerRef} AND released_at IS NULL
            LIMIT 1`,
      );
      const existingByWorker = (existingByWorkerResult as { rows: { id: string; code_id: string; worker_id: string; employment_session_id: string }[] }).rows[0];

      // 3. Exact already-active assignment => safe skip
      if (
        existingByCode &&
        existingByCode.worker_id === adoption.workerRef &&
        existingByCode.employment_session_id === adoption.employmentSessionId
      ) {
        // Invariant: never leave an active assignment attached to AVAILABLE or RETIRED
        // (Note: dw_codes has no updated_at column; only status and code are updated)
        if (codeRow && (codeRow.status !== "ASSIGNED" || codeRow.code !== adoption.code)) {
          await tx.execute(sql`
            UPDATE dw_codes
            SET status = 'ASSIGNED', code = ${adoption.code}
            WHERE id = ${codeRow.id}
          `);
        }
        skippedDwCount++;
        continue;
      }

      // 4. Conflicting ownership => reject (fail closed)
      if (existingByCode) {
        throw new Error(
          `ACTIVATION_CONFLICT: DW Code "${adoption.code}" already has an active assignment to a different worker/session. Cannot reassign.`,
        );
      }

      if (existingByWorker && (!codeRow || existingByWorker.code_id !== codeRow.id)) {
        throw new Error(
          `ACTIVATION_CONFLICT: Worker "${adoption.workerRef}" already has an active DW Code assignment. Cannot create a second one.`,
        );
      }

      // 5. Valid adoption => ensure dw_codes row exists and ends with status = ASSIGNED
      let codeId = codeRow?.id;
      if (!codeRow) {
        await tx.execute(sql`
          INSERT INTO dw_codes (location_id, sequence_number, code, status)
          VALUES (${adoption.locationId}, ${adoption.sequenceNumber}, ${adoption.code}, 'ASSIGNED')
          ON CONFLICT (location_id, sequence_number) DO UPDATE
            SET status = 'ASSIGNED', code = EXCLUDED.code
        `);
        const fetchRes = await tx.execute<{ id: string; status: string }>(
          sql`SELECT id, status FROM dw_codes WHERE code = ${adoption.code} LIMIT 1`,
        );
        const fetched = (fetchRes as { rows: { id: string; status: string }[] }).rows[0];
        if (!fetched) throw new Error(`ACTIVATION_INTERNAL: dw_codes row for code "${adoption.code}" not found after insert.`);
        codeId = fetched.id;
      } else {
        await tx.execute(sql`
          UPDATE dw_codes
          SET status = 'ASSIGNED', code = ${adoption.code}
          WHERE id = ${codeId}
        `);
      }

      // 6. Insert active assignment attached to ASSIGNED code
      await tx.execute(sql`
        INSERT INTO dw_code_assignments
          (code_id, worker_id, employment_session_id, dw_data_id, assigned_by)
        VALUES
          (${codeId}, ${adoption.workerRef}, ${adoption.employmentSessionId}, ${adoption.dwDataId}, 'SYSTEM_ACTIVATION')
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
          activationContentChecksum,
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
      activationContentChecksum,
      checksum: activationContentChecksum,
      protectedDwCount,
      adoptedDwCount,
      adoptedItCount,
      skippedDwCount,
      skippedItCount,
    };
  });
}
