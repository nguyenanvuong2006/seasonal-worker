#!/usr/bin/env node
/**
 * DIAGNOSE STUCK MERGE JOBS — READ-ONLY, PRODUCTION-SAFE.
 *
 * Investigates why merge_jobs rows are stuck QUEUED/PROCESSING (or recently
 * FAILED) instead of reaching COMPLETED. SELECT-only — this script never
 * UPDATEs/DELETEs/INSERTs anything. It never reads candidate PII: it queries
 * only merge_jobs + merge_job_records, and from merge_job_records it never
 * selects source_record_id (the FK into daily_applications) or any candidate
 * field — only queue/lease/error diagnostics.
 *
 * Cách dùng:
 *   DATABASE_URL=postgres://... node scripts/diagnose-stuck-merge-jobs.mjs
 *
 * Output: JSON to stdout. Includes:
 *   - every non-terminal job (QUEUED/PROCESSING) regardless of age
 *   - FAILED jobs created within FAILED_WINDOW_HOURS (default 48h)
 *   - for each: job-level diagnostics (status, counts, metadata.lastStage,
 *     output artifact existence booleans — never the raw URLs) + per-item
 *     diagnostics (status, attempt_count, lease/retry timing, error_code,
 *     truncated error_message, whether an output PDF/history link exists)
 *   - the EXACT row the watchdog's own SELECT (worker/src/index.ts /run
 *     watchdog-mode query) would currently pick — to prove/disprove
 *     single-job-per-invocation starvation when multiple jobs are eligible.
 */
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
  process.exit(1);
}
const FAILED_WINDOW_HOURS = Number(process.env.FAILED_WINDOW_HOURS ?? "48");

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const host = (() => {
  try {
    return new URL(DATABASE_URL).hostname;
  } catch {
    return "(không parse được host)";
  }
})();
console.log(JSON.stringify({ event: "connected", host }));

// 1) Jobs of interest: all non-terminal + recently-FAILED. Never selects any
// PII column — only queue-state, timing, engine, and boolean artifact flags.
const jobsResult = await client.query(
  `SELECT
      id,
      engine,
      status,
      template_id,
      record_count,
      queued_count,
      processing_count,
      completed_count,
      failed_count,
      progress_percent,
      created_at,
      started_at,
      completed_at,
      updated_at,
      (output_doc_id IS NOT NULL) AS has_output_doc_id,
      (output_url IS NOT NULL) AS has_output_url,
      (output_pdf_url IS NOT NULL) AS has_output_pdf_url,
      (output_zip_url IS NOT NULL) AS has_output_zip_url,
      left(error_summary, 500) AS error_summary,
      metadata->'lastStage' AS last_stage,
      (metadata->'googleDocs' IS NOT NULL) AS has_google_docs_snapshot
    FROM merge_jobs
   WHERE status IN ('QUEUED', 'PROCESSING')
      OR (status = 'FAILED' AND created_at > now() - ($1 || ' hours')::interval)
   ORDER BY created_at DESC`,
  [String(FAILED_WINDOW_HOURS)],
);
console.log(JSON.stringify({ event: "jobs_of_interest", count: jobsResult.rows.length, jobs: jobsResult.rows }, null, 2));

// 2) Per-item diagnostics for each job found above — status/lease/retry/error
// only. source_record_id (candidate FK) is deliberately NEVER selected.
for (const job of jobsResult.rows) {
  const itemsResult = await client.query(
    `SELECT
        id,
        source_entity,
        status,
        sort_order,
        attempt_count,
        leased_until,
        retry_at,
        started_at,
        completed_at,
        error_code,
        left(error_message, 500) AS error_message,
        (document_history_id IS NOT NULL) AS has_document_history,
        (pdf_url IS NOT NULL) AS has_pdf_url
      FROM merge_job_records
     WHERE merge_job_id = $1
     ORDER BY sort_order ASC`,
    [job.id],
  );
  console.log(
    JSON.stringify(
      {
        event: "job_items",
        jobId: job.id,
        itemCount: itemsResult.rows.length,
        statusBreakdown: itemsResult.rows.reduce((acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        }, {}),
        items: itemsResult.rows,
      },
      null,
      2,
    ),
  );
}

// 3) EXACT watchdog-mode selection query from worker/src/index.ts's /run
// handler (no jobId body). LIMIT 1, no ORDER BY — run it verbatim to see
// which single job it currently resolves to, proving/disproving whether
// other eligible non-terminal jobs are starved because the watchdog only
// ever processes one job per invocation and this query keeps returning the
// same row.
const watchdogPick = await client.query(
  `SELECT id, engine, status, created_at
     FROM merge_jobs
    WHERE status IN ('QUEUED', 'PROCESSING')
      AND engine IN ('HTML_PDF', 'GOOGLE_DOCS')
    LIMIT 1`,
);
const eligibleCount = await client.query(
  `SELECT count(*)::int AS n
     FROM merge_jobs
    WHERE status IN ('QUEUED', 'PROCESSING')
      AND engine IN ('HTML_PDF', 'GOOGLE_DOCS')`,
);
console.log(
  JSON.stringify(
    {
      event: "watchdog_query_result",
      eligibleNonTerminalJobs: eligibleCount.rows[0].n,
      watchdogWouldPick: watchdogPick.rows[0] ?? null,
      starvationRisk:
        eligibleCount.rows[0].n > 1
          ? `${eligibleCount.rows[0].n} eligible jobs but the watchdog query has no ORDER BY and LIMIT 1 — every invocation may resolve to the same row, starving the others until it becomes terminal.`
          : null,
    },
    null,
    2,
  ),
);

await client.end();
console.log(JSON.stringify({ event: "done" }));
