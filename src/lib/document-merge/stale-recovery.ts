/**
 * Document Merge — stale job / stuck-queue recovery (INCIDENT: job stuck
 * PROCESSING with 1 QUEUED item that is never claimed).
 *
 * Two execution engines share the merge_jobs / merge_job_records tables:
 *
 *  - GOOGLE_DOCS: ASYNC since the 28–29/08 incident — POST /merge/execute
 *    creates a QUEUED job + QUEUED items with a frozen googleDocs snapshot
 *    and triggers the Cloud Run worker, which claims items (SKIP LOCKED),
 *    heartbeats its lease and does the Google Docs/Drive work. The worker's
 *    own runJob() first reclaims expired-lease PROCESSING items, so a worker
 *    crash is self-healing on the next invocation.
 *    LEGACY rows (created before the async move) have status RUNNING and
 *    items PENDING — nothing can resume them, so they are failed loudly here
 *    (sync-killed). Async jobs (items QUEUED/RETRY/PROCESSING) are NEVER
 *    failed by that predicate — they are reclaimed / re-dispatched instead.
 *
 *  - HTML_PDF: ASYNC queue — Cloud Run worker claims items
 *    (FOR UPDATE SKIP LOCKED). The only trigger is the single after()
 *    fire-and-forget call right after job creation (and after retry). If that
 *    trigger dies (misconfig/auth/deployment protection) the job stays QUEUED
 *    with QUEUED items; this module re-dispatches it.
 *
 * This module is the missing safety net for BOTH engines. It runs only through
 * the explicit recovery actors:
 *   - the authenticated cron watchdog (src/lib/scheduler.ts
 *     RECOVER_STALE_MERGE_JOBS — daily Vercel cron), and
 *   - the interactive merge-WRITE trigger (src/lib/document-merge/
 *     pre-merge-recovery.ts, invoked by POST /api/document-merge/merge/execute
 *     BEFORE a new job is created — because the daily cron alone can leave a
 *     zombie visible for up to 24 hours).
 * GET /api/document-merge/jobs/[id] stays strictly read-only. Recovery only
 * touches rows whose staleness proves the owning invocation is gone, so it is
 * idempotent and safe to run repeatedly.
 *
 * Every write is a SINGLE conditional SQL statement (no manual BEGIN/COMMIT),
 * which is safe on pooled/PgBouncer transaction-mode connections — the same
 * invariant the queue claim path relies on.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

// Liveness model (see queue.ts SYNC_ITEM_LEASE_SECONDS + touchSyncMerge):
// the synchronous GOOGLE_DOCS merge refreshes merge_jobs.updated_at and the
// item leased_until lease around EVERY long external stage (Docs read, copy,
// batchUpdate, Drive export/upload, per-candidate). Lease = 60s; worst-case
// gap between heartbeats for one candidate's external calls is bounded by the
// Google fetch timeout (30s + retries) ≈ under ~2 lease intervals. A job that
// has made NO progress (no heartbeat) for STALE_AFTER_NO_PROGRESS_MS is treated
// as dead. This is a LAST-PROGRESS/lease check, NOT a wall-clock age check, so
// a large healthy batch that keeps making progress is NEVER reclaimed no
// matter how long it has been running.
export const SYNC_LEASE_MS = 60_000; // = SYNC_ITEM_LEASE_SECONDS
export const GOOGLE_FETCH_TIMEOUT_MS = 30_000; // fetchWithTimeout default
export const STALE_AFTER_NO_PROGRESS_MS = 5 * 60_000; // ~5 silent lease intervals

// Legacy aliases kept for the tests/report:
export const STALE_SYNC_GRACE_MS = STALE_AFTER_NO_PROGRESS_MS;
export const STALE_DISPATCH_MS = 2 * 60_000; // HTML_PDF trigger never arrived
export const STALE_PROCESSING_MS = STALE_AFTER_NO_PROGRESS_MS; // worker stopped heartbeating

export interface StaleRecoveryResult {
  /** How many GOOGLE_DOCS jobs were moved PROCESSING/RUNNING → FAILED. */
  syncFailed: number;
  /** How many stale PROCESSING items were reclaimed back to RETRY. */
  processingReclaimed: number;
  /** HTML_PDF jobs whose QUEUED items need a fresh worker dispatch. */
  dispatchJobIds: string[];
  /** Ids of jobs that were touched (FAILED or had an item reclaimed). */
  recoveredJobIds: string[];
}

/**
 * Recover a SINGLE job (read-time self-heal). `now` is injectable for tests.
 *
 * @param jobId      job to recover
 * @param opts.now   current time (default wall clock)
 * @param opts.fire  called for HTML_PDF jobs that need a re-dispatch — the
 *                   caller owns the actual trigger so this module stays
 *                   engine/transport-agnostic and testable.
 */
export async function recoverStaleMergeJob(
  jobId: string,
  opts: { now?: Date; fire?: (jobId: string) => void } = {},
): Promise<StaleRecoveryResult> {
  return runRecovery({ singleJobId: jobId, now: opts.now ?? new Date(), fire: opts.fire });
}

/**
 * Watchdog sweep across ALL non-terminal jobs (cron / interactive trigger).
 * Async worker-queue jobs (HTML_PDF and GOOGLE_DOCS) get reclaimed/re-
 * dispatched to the worker; pure LEGACY GOOGLE_DOCS zombies (RUNNING job +
 * PENDING items, no claimable item shape) cannot be safely resumed — their
 * request state is gone — and are failed loudly instead.
 */
export async function recoverStaleMergeJobs(
  opts: { now?: Date; fire?: (jobId: string) => void } = {},
): Promise<StaleRecoveryResult> {
  return runRecovery({ now: opts.now ?? new Date(), fire: opts.fire });
}

type RecoveryOpts = {
  now: Date;
  singleJobId?: string;
  fire?: (jobId: string) => void;
};

async function runRecovery({ now, singleJobId, fire }: RecoveryOpts): Promise<StaleRecoveryResult> {
  const result: StaleRecoveryResult = {
    syncFailed: 0,
    processingReclaimed: 0,
    dispatchJobIds: [],
    recoveredJobIds: [],
  };

  const single = singleJobId ? sql`AND j.id = ${singleJobId}` : sql``;
  // Liveness cutoff: last-progress (updated_at / leased_until) older than this
  // ⇒ the owning invocation can no longer legitimately continue.
  const noProgressCutoff = new Date(now.getTime() - STALE_AFTER_NO_PROGRESS_MS);
  const dispatchGrace = new Date(now.getTime() - STALE_DISPATCH_MS);
  const processingGrace = new Date(now.getTime() - STALE_PROCESSING_MS);

  // 1. Dead LEGACY GOOGLE_DOCS synchronous jobs — decided on LAST PROGRESS (the
  //    liveness lease), NOT on created_at wall-clock age. Only the legacy
  //    shape matches: a RUNNING/PROCESSING GOOGLE_DOCS job whose non-terminal
  //    items are ALL PENDING/RUNNING (born under the old synchronous model —
  //    no worker can claim those). ASYNC GOOGLE_DOCS jobs are excluded by the
  //    NOT EXISTS guard (any QUEUED/RETRY/PROCESSING item is recoverable by
  //    the worker), and a fresh item lease always exempts a live owner.
  const syncDead = await db.execute<Record<string, unknown>>(sql`
    /* recover-sync-killed */
    WITH dead AS (
      SELECT j.id
        FROM merge_jobs j
       WHERE j.status IN ('RUNNING', 'PROCESSING')
         AND COALESCE(j.engine, 'GOOGLE_DOCS') = 'GOOGLE_DOCS'
         AND j.updated_at < ${noProgressCutoff}
         AND NOT EXISTS (
               -- an item whose lease is still held ⇒ a request is actively
               -- working RIGHT NOW; never reclaim it.
               SELECT 1 FROM merge_job_records r
                WHERE r.merge_job_id = j.id
                  AND r.status = 'PROCESSING'
                  AND r.leased_until IS NOT NULL
                  AND r.leased_until > ${now}
             )
         AND NOT EXISTS (
               -- async-model job: any QUEUED/RETRY/PROCESSING item is
               -- recoverable by the worker (claim/reclaim) — never fail the
               -- job here. Only the pure legacy shape (all non-terminal
               -- items PENDING/RUNNING) is a dead synchronous zombie.
               SELECT 1 FROM merge_job_records r2
                WHERE r2.merge_job_id = j.id
                  AND r2.status IN ('QUEUED', 'RETRY', 'PROCESSING')
             )
         ${single}
       FOR UPDATE OF j
       SKIP LOCKED
    ),
    fail_items AS (
      UPDATE merge_job_records r
         SET status = 'FAILED',
             error_code = COALESCE(r.error_code, 'STALE_SYNC_KILLED'),
             error_message = COALESCE(
               r.error_message,
               'Tiến trình merge đã bị gián đoạn (không còn tín hiệu hoạt động). Vui lòng chạy lại merge cho hồ sơ này.'
             ),
             leased_until = NULL,
             retry_at = NULL,
             completed_at = ${now}
        FROM dead
       WHERE r.merge_job_id = dead.id
         AND r.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
      RETURNING r.merge_job_id
    ),
    fail_jobs AS (
      UPDATE merge_jobs j
         SET status = 'FAILED',
             error_summary = COALESCE(
               j.error_summary,
               'Tiến trình merge đã bị gián đoạn (mất tín hiệu hoạt động quá hạn) — job bị đánh dấu thất bại bởi watchdog. Chạy lại merge để tạo tài liệu.'
             ),
             completed_at = ${now},
             updated_at = ${now}
        FROM dead
       WHERE j.id = dead.id
      RETURNING j.id
    )
    SELECT (SELECT count(*) FROM fail_jobs)::int AS "syncFailed",
           (SELECT count(*) FROM fail_items)::int AS "itemsFailed",
           COALESCE((SELECT json_agg(id) FROM fail_jobs), '[]'::json) AS "jobIds"
  `);
  const syncRow = (syncDead.rows ?? [])[0] as
    | { syncFailed: number; itemsFailed: number; jobIds: string[] }
    | undefined;
  if (syncRow && Number(syncRow.syncFailed) > 0) {
    result.syncFailed += Number(syncRow.syncFailed);
    result.recoveredJobIds.push(...(Array.isArray(syncRow.jobIds) ? syncRow.jobIds : []));
  }

  // 2. Reclaim stale PROCESSING items of worker-queue jobs (HTML_PDF and the
  //    async GOOGLE_DOCS executor) whose LEASE has expired and not been
  //    renewed for the stale window. The worker now heartbeats leased_until
  //    through EVERY long stage (data load, render/Google calls, upload,
  //    history, dispatch), so a held-and-fresh lease proves a healthy owner is
  //    progressing; reclaim only happens once no heartbeat arrived for the
  //    full STALE_AFTER_NO_PROGRESS_MS interval. SKIP LOCKED ensures two
  //    watchdogs never reclaim the same live item.
  const reclaimed = await db.execute<Record<string, unknown>>(sql`
    /* recover-stale-processing */
    WITH stale AS (
      SELECT r.id, r.merge_job_id
        FROM merge_job_records r
        JOIN merge_jobs j ON j.id = r.merge_job_id
       WHERE r.status = 'PROCESSING'
         AND j.engine IN ('HTML_PDF', 'GOOGLE_DOCS')
         AND (r.leased_until IS NULL OR r.leased_until < ${processingGrace})
         ${singleJobId ? sql`AND r.merge_job_id = ${singleJobId}` : sql``}
       FOR UPDATE OF r
       SKIP LOCKED
    )
    UPDATE merge_job_records rr
       SET status = 'RETRY', leased_until = NULL, retry_at = ${now}
      FROM stale
     WHERE rr.id = stale.id
    RETURNING rr.merge_job_id AS "jobId"
  `);
  for (const row of (reclaimed.rows ?? []) as { jobId: string }[]) {
    result.processingReclaimed += 1;
    if (!result.recoveredJobIds.includes(row.jobId)) result.recoveredJobIds.push(row.jobId);
    if (!result.dispatchJobIds.includes(row.jobId)) result.dispatchJobIds.push(row.jobId);
  }

  // 3. Orphaned worker-queue jobs (HTML_PDF and async GOOGLE_DOCS): still
  //    QUEUED with QUEUED/RETRY items long after creation but never reached
  //    by any worker (the single after() trigger failed). Re-dispatch.
  const orphan = await db.execute<Record<string, unknown>>(sql`
    /* recover-orphan-dispatch */
    SELECT j.id AS "jobId"
      FROM merge_jobs j
     WHERE j.status IN ('QUEUED', 'PROCESSING')
       AND j.engine IN ('HTML_PDF', 'GOOGLE_DOCS')
       AND j.created_at < ${dispatchGrace}
       AND EXISTS (
             SELECT 1 FROM merge_job_records r
              WHERE r.merge_job_id = j.id
                AND r.status IN ('QUEUED', 'RETRY')
                AND (r.retry_at IS NULL OR r.retry_at <= ${now})
           )
       AND NOT EXISTS (
             SELECT 1 FROM merge_job_records r
              WHERE r.merge_job_id = j.id AND r.status = 'PROCESSING'
           )
       ${single}
       FOR UPDATE OF j
       SKIP LOCKED
  `);
  for (const row of (orphan.rows ?? []) as { jobId: string }[]) {
    if (!result.dispatchJobIds.includes(row.jobId)) result.dispatchJobIds.push(row.jobId);
  }

  // 4. Fire the (single) re-dispatch callback per orphaned/reclaimed job.
  //    The worker's own claim (SKIP LOCKED) + completeItem guards keep this
  //    safe if an invocation actually turns out to be alive.
  for (const jobId of result.dispatchJobIds) {
    try {
      fire?.(jobId);
    } catch {
      // A failed trigger must not crash the watchdog — it retries next run.
    }
  }

  return result;
}
