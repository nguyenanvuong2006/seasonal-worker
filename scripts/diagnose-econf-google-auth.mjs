#!/usr/bin/env node
/**
 * DIAGNOSE — electronic-confirmation ("Hồ sơ xác nhận điện tử") candidate
 * document generation/storage path, READ-ONLY.
 *
 * Traces exactly what the mission asks for, without assuming the old
 * "Token has been expired or revoked" error is still current:
 *   - candidate_documents: recent rows by status (esp. FAILED), error_message
 *   - merge_job_records linked to those documents: status/engine/error_code/
 *     error_message/storage_key presence/sha256 presence
 *   - merge_jobs for those records: engine/status/error_summary
 *
 * Never selects candidate PII (no full_name/cccd/phone/address — only IDs,
 * statuses, timestamps, and error text already meant for operator eyes in
 * the admin UI). Never writes anything.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/diagnose-econf-google-auth.mjs
 * Output: NDJSON events to stdout.
 */
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
  process.exit(1);
}

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

// 1) candidate_documents status breakdown (all-time — small table, no PII selected).
const { rows: statusCounts } = await client.query(
  `SELECT status, count(*)::int AS count FROM candidate_documents GROUP BY status ORDER BY status`,
);
console.log(JSON.stringify({ event: "candidate_document_status_counts", counts: statusCounts }));

// 2) Most recent 20 candidate_documents rows (any status) — IDs/status/error/storage only.
const { rows: recentDocs } = await client.query(
  `SELECT id, status, error_message, storage_provider, storage_key IS NOT NULL AS has_storage_key,
          pdf_sha256 IS NOT NULL AS has_sha256, file_size, template_id, merge_job_id, merge_job_record_id,
          created_at, updated_at, generated_at, issued_at
   FROM candidate_documents
   ORDER BY created_at DESC
   LIMIT 20`,
);
console.log(JSON.stringify({ event: "recent_candidate_documents", rows: recentDocs }));

// 3) All FAILED candidate_documents in the last 30 days — the exact evidence
//    needed to confirm/refute whether the old expired-token error is current.
const { rows: failedDocs } = await client.query(
  `SELECT id, error_message, merge_job_id, merge_job_record_id, template_id, created_at, updated_at
   FROM candidate_documents
   WHERE status = 'FAILED' AND created_at > now() - interval '30 days'
   ORDER BY updated_at DESC
   LIMIT 50`,
);
console.log(JSON.stringify({ event: "failed_candidate_documents_last_30d", count: failedDocs.length, rows: failedDocs }));

// 4) The merge_job_records linked to those FAILED candidate_documents — this
//    is where the ACTUAL Google/storage error_code/error_message lives
//    (candidate_documents.error_message is often just a copy/summary).
const recordIds = [...new Set(failedDocs.map((d) => d.merge_job_record_id).filter(Boolean))];
if (recordIds.length > 0) {
  const { rows: records } = await client.query(
    `SELECT id, merge_job_id, status, error_code, error_message, storage_key IS NOT NULL AS has_storage_key,
            sha256 IS NOT NULL AS has_sha256, file_size, attempt_count, started_at, completed_at
     FROM merge_job_records
     WHERE id = ANY($1::uuid[])`,
    [recordIds],
  );
  console.log(JSON.stringify({ event: "linked_merge_job_records", count: records.length, rows: records }));

  const jobIds = [...new Set(records.map((r) => r.merge_job_id).filter(Boolean))];
  if (jobIds.length > 0) {
    const { rows: jobs } = await client.query(
      `SELECT id, engine, status, error_summary, created_at, completed_at
       FROM merge_jobs
       WHERE id = ANY($1::uuid[])`,
      [jobIds],
    );
    console.log(JSON.stringify({ event: "linked_merge_jobs", count: jobs.length, rows: jobs }));
  }
} else {
  console.log(JSON.stringify({ event: "linked_merge_job_records", count: 0, rows: [] }));
}

// 5) Any merge_job_records (regardless of candidate_documents linkage) whose
//    error_message mentions the specific historical symptom, to answer
//    OLD_TOKEN_ERROR_STILL_REPRODUCIBLE directly from evidence, not guesswork.
const { rows: tokenErrors } = await client.query(
  `SELECT id, merge_job_id, status, error_code, error_message, completed_at
   FROM merge_job_records
   WHERE (error_message ILIKE '%expired or revoked%' OR error_message ILIKE '%invalid_grant%'
          OR error_code ILIKE '%AUTH%')
   ORDER BY completed_at DESC NULLS LAST
   LIMIT 30`,
);
console.log(JSON.stringify({ event: "token_or_auth_error_records", count: tokenErrors.length, rows: tokenErrors }));

// 6) Recent GOOGLE_DOCS merge_jobs overall (engine/status/error_summary) —
//    shows whether item-level (worker-side Docs creation) is currently
//    healthy, isolating that from the finalize-step (Vercel-side) failure.
const { rows: recentJobs } = await client.query(
  `SELECT id, engine, status, record_count, error_summary, created_by, created_at, completed_at
   FROM merge_jobs
   WHERE engine IN ('GOOGLE_DOCS', 'HTML_PDF')
   ORDER BY created_at DESC
   LIMIT 15`,
);
console.log(JSON.stringify({ event: "recent_merge_jobs", rows: recentJobs }));

// 7) document_confirmations count (immutable evidence table) — sanity check
//    that the confirm step has ever produced a row (existence only, no PII).
const { rows: confirmCount } = await client.query(`SELECT count(*)::int AS count FROM document_confirmations`);
console.log(JSON.stringify({ event: "document_confirmations_count", count: confirmCount[0]?.count ?? 0 }));

await client.end();
console.log(JSON.stringify({ event: "done" }));
