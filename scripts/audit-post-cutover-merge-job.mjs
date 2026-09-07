#!/usr/bin/env node
/**
 * AUDIT POST-CUTOVER MERGE JOB — READ-ONLY, PRODUCTION-SAFE.
 *
 * Purpose-built for the HTML_PDF Production engine cutover (2026-09): after
 * DOCUMENT_MERGE_ENGINE is switched to HTML_PDF and one real merge is run
 * through the Production UI, this script finds and reports on the most
 * recently created merge_jobs row and proves — from the DB directly, not
 * from inference — that it:
 *   - is engine=HTML_PDF (not GOOGLE_DOCS)
 *   - carries a frozen metadata.templates[tid] snapshot whose version/margins
 *     match the currently PUBLISHED template version
 *   - has that snapshot's htmlBody/printCss content-identical (sha256) to the
 *     live PUBLISHED row — proving the frozen snapshot really is v18's
 *     content, not merely a version NUMBER that happens to say 18
 *   - reached a terminal job status, with per-record output-artifact
 *     existence (pdfUrl/sha256/fileSize booleans only)
 *
 * SELECT-only. Never UPDATEs/DELETEs/INSERTs. Never reads candidate PII: from
 * merge_job_records it selects only queue/output-existence columns — never
 * source_record_id (the FK into daily_applications) or any candidate field.
 * From merge_jobs.metadata.templates it extracts only version/margins and a
 * sha256 of htmlBody/printCss (template content — placeholders, not
 * candidate data) — never the raw content itself, matching this repo's
 * existing DUMP_CONTENT-gated convention for template bodies.
 *
 * Cách dùng:
 *   DATABASE_URL=postgres://... node scripts/audit-post-cutover-merge-job.mjs
 *
 * Optional env:
 *   JOB_ID=<uuid>          audit this specific job instead of "most recent"
 *   SINCE=<ISO timestamp>  only consider jobs created at/after this time
 *   DUMP_CONTENT=true      also print the frozen snapshot's raw htmlBody/
 *                          printCss (template content — placeholders, not
 *                          candidate data). Opt-in only, same convention as
 *                          audit-remediate-published-template-margins.mjs's
 *                          DUMP_CONTENT gate — off by default to keep
 *                          routine runs lean.
 *
 * Output: NDJSON to stdout (one JSON object per line).
 */
import pg from "pg";
import { createHash } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
  process.exit(1);
}
const JOB_ID = process.env.JOB_ID || null;
const SINCE = process.env.SINCE || null;
const DUMP_CONTENT = process.env.DUMP_CONTENT === "1" || process.env.DUMP_CONTENT === "true";

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

const sha256 = (s) => (s ? createHash("sha256").update(s, "utf8").digest("hex") : null);

let job;
if (JOB_ID) {
  const { rows } = await client.query(`SELECT * FROM merge_jobs WHERE id = $1 LIMIT 1`, [JOB_ID]);
  job = rows[0];
} else {
  const params = [];
  let where = "";
  if (SINCE) {
    params.push(SINCE);
    where = `WHERE created_at >= $1`;
  }
  const { rows } = await client.query(
    `SELECT * FROM merge_jobs ${where} ORDER BY created_at DESC LIMIT 1`,
    params,
  );
  job = rows[0];
}

if (!job) {
  console.log(JSON.stringify({ event: "no_job_found", jobId: JOB_ID, since: SINCE }));
  await client.end();
  process.exit(0);
}

const templates = job.metadata && typeof job.metadata === "object" ? job.metadata.templates ?? {} : {};
const snapshotEntries = Object.entries(templates);
const snapshots = snapshotEntries.map(([tid, snap]) => ({
  templateId: tid,
  version: snap?.version ?? null,
  margins: snap?.margins ?? null,
  htmlBodyLength: snap?.htmlBody?.length ?? null,
  htmlBodySha256: sha256(snap?.htmlBody ?? null),
  printCssLength: snap?.printCss?.length ?? null,
  printCssSha256: sha256(snap?.printCss ?? null),
}));

console.log(
  JSON.stringify({
    event: "job",
    id: job.id,
    engine: job.engine,
    status: job.status,
    templateId: job.template_id,
    mergeMode: job.merge_mode,
    recordCount: job.record_count,
    queuedCount: job.queued_count,
    processingCount: job.processing_count,
    completedCount: job.completed_count,
    failedCount: job.failed_count,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    updatedAt: job.updated_at,
    hasOutputDocId: job.output_doc_id !== null,
    hasOutputUrl: job.output_url !== null,
    hasOutputPdfUrl: job.output_pdf_url !== null,
    hasOutputZipUrl: job.output_zip_url !== null,
    errorSummary: job.error_summary ? String(job.error_summary).slice(0, 500) : null,
    snapshots,
  }),
);

if (DUMP_CONTENT) {
  for (const [tid, snap] of snapshotEntries) {
    console.log(
      JSON.stringify({
        event: "content_dump",
        jobId: job.id,
        templateId: tid,
        htmlBody: snap?.htmlBody ?? null,
        printCss: snap?.printCss ?? null,
      }),
    );
  }
}

// Cross-check every snapshot's templateId against the CURRENTLY PUBLISHED
// version of that template — proves the frozen snapshot really is that
// PUBLISHED content (sha256-identical), not just a version number.
for (const snap of snapshots) {
  const { rows: publishedRows } = await client.query(
    `SELECT mtv.version, mtv.html_body, mtv.print_css,
            mtv.margin_top_mm, mtv.margin_bottom_mm, mtv.margin_left_mm, mtv.margin_right_mm,
            mt.html_enabled
       FROM merge_templates mt
       JOIN merge_template_versions mtv
         ON mtv.template_id = mt.id AND mtv.version = mt.current_published_version
      WHERE mt.id = $1
      LIMIT 1`,
    [snap.templateId],
  );
  const published = publishedRows[0];
  const publishedHtmlSha = sha256(published?.html_body ?? null);
  const publishedCssSha = sha256(published?.print_css ?? null);
  console.log(
    JSON.stringify({
      event: "snapshot_vs_published",
      templateId: snap.templateId,
      snapshotVersion: snap.version,
      publishedVersion: published?.version ?? null,
      versionMatches: published ? snap.version === published.version : null,
      htmlEnabled: published?.html_enabled ?? null,
      publishedMargins: published
        ? {
            top: published.margin_top_mm,
            bottom: published.margin_bottom_mm,
            left: published.margin_left_mm,
            right: published.margin_right_mm,
          }
        : null,
      snapshotMarginsMatchPublished: published
        ? snap.margins?.topMm === published.margin_top_mm &&
          snap.margins?.bottomMm === published.margin_bottom_mm &&
          snap.margins?.leftMm === published.margin_left_mm &&
          snap.margins?.rightMm === published.margin_right_mm
        : null,
      htmlBodyContentIdentical: published ? snap.htmlBodySha256 === publishedHtmlSha : null,
      printCssContentIdentical: published ? snap.printCssSha256 === publishedCssSha : null,
    }),
  );
}

// Per-record output-artifact existence — booleans/status only, never
// source_record_id or any candidate field.
const { rows: records } = await client.query(
  `SELECT id, status, template_id, attempt_count, started_at, completed_at,
          (pdf_url IS NOT NULL) AS has_pdf_url,
          (sha256 IS NOT NULL) AS has_sha256,
          file_size,
          left(error, 500) AS error
     FROM merge_job_records
    WHERE merge_job_id = $1
    ORDER BY sort_order ASC`,
  [job.id],
);
console.log(
  JSON.stringify({
    event: "job_records",
    jobId: job.id,
    count: records.length,
    statusBreakdown: records.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {}),
    records,
  }),
);

await client.end();
console.log(JSON.stringify({ event: "done" }));
