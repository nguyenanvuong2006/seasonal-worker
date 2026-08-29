/**
 * Document Merge — interactive stale-merge recovery on the merge WRITE path.
 *
 * WHY (incident 28–29/08): recovery used to run ONLY from the daily Vercel
 * cron (src/lib/scheduler.ts RECOVER_STALE_MERGE_JOBS). On the Vercel Hobby
 * plan cron is capped at one run per day, so a GOOGLE_DOCS job whose
 * serverless request was killed mid-flight (platform maxDuration / hung
 * Google call) stays RUNNING/PROCESSING as a zombie for up to ~24 hours.
 *
 * POST /api/document-merge/merge/execute is the natural interactive trigger:
 * the operator is actively using the merge feature at exactly the moment a
 * stuck job hurts, and the route is a MUTATING endpoint — the read-only GET
 * polling guarantee from PR #125 (jobs/[id] never mutates) is untouched.
 *
 * SAFETY (identical to the cron watchdog):
 *   - Same liveness predicate + single conditional SQL statements
 *     (SKIP LOCKED, idempotent, CAS) as the cron path — a live job whose
 *     lease is still being refreshed can never be failed here.
 *   - Runs BEFORE the new job is inserted, so it can never touch the job
 *     this request is about to create.
 *   - Never throws — a recovery failure must never block a new merge.
 *   - PII-free structured logging (counts only).
 */
import "server-only";
import { recoverStaleMergeJobs, type StaleRecoveryResult } from "./stale-recovery";

export async function runPreMergeStaleRecovery(): Promise<StaleRecoveryResult | null> {
  try {
    // Dynamic import keeps the worker-auth/after() modules out of this
    // module's static import graph (same pattern as the cron scheduler).
    const { triggerPdfWorker } = await import("./worker-trigger");
    const result = await recoverStaleMergeJobs({
      fire: (jobId) => triggerPdfWorker(jobId),
    });
    if (result.syncFailed > 0 || result.processingReclaimed > 0 || result.dispatchJobIds.length > 0) {
      console.log(
        JSON.stringify({
          event: "pre_merge_stale_recovery",
          syncFailed: result.syncFailed,
          processingReclaimed: result.processingReclaimed,
          redispatched: result.dispatchJobIds.length,
          recoveredCount: result.recoveredJobIds.length,
        }),
      );
    }
    return result;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "pre_merge_stale_recovery_failed",
        error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      }),
    );
    return null;
  }
}
