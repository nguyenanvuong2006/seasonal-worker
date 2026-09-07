#!/usr/bin/env node
/**
 * AUDIT + REMEDIATE — legacy embedded `@page` rule in a currently PUBLISHED
 * Document Merge template's print_css.
 *
 * BACKGROUND (root cause fixed by html-renderer.ts's pageGeometryCss(), see
 * its docblock): the renderer now always emits `@page { margin: 0 }` and
 * applies margin exactly once via `.page`/`.paper` padding, injected LAST in
 * the concatenated stylesheet. That guarantee covers `.page`/`.paper`
 * width/min-height/padding, but NOT `@page` itself — if a template's own
 * stored print_css declares its own `@page { margin: ... }` rule (as the
 * trainee-registration template's historical generator,
 * scripts/sync-trainee-registration-v7.mjs's RUNTIME_PARITY_CSS, does), that
 * rule is concatenated AFTER the renderer's `@page { margin: 0 }` and wins
 * the CSS cascade for the `margin` property — silently reintroducing the
 * double-margin defect for that specific published content, even though the
 * architecture is correct for anything published from now on.
 *
 * READ-ONLY AUDIT (always runs, every template with a PUBLISHED version):
 * reports templateId/version/whether print_css contains an `@page` rule and
 * the exact matched rule text, plus merge_templates.html_enabled (read-only,
 * added 2026-09 to confirm HTML/PDF eligibility ahead of the HTML_PDF
 * production engine switch — createAsyncMergeJob() requires this true for
 * any HTML_PDF job).
 *
 * CONDITIONAL REMEDIATION (only when an `@page` rule is found AND no
 * matching remediation DRAFT already exists): INSERTs exactly ONE new DRAFT
 * version. It NEVER updates/deletes the PUBLISHED row, NEVER touches
 * merge_templates.current_published_version, merge_jobs, merge_job_records,
 * document_history, merge_template_fields, or any candidate data. The new
 * DRAFT:
 *   - html_body: byte-identical copy of the PUBLISHED version's html_body
 *     (every mapping/placeholder/content preserved verbatim — nothing here
 *     ever parses or rewrites the body).
 *   - print_css: PUBLISHED version's print_css with ONLY `@page { ... }`
 *     block(s) removed via a scoped regex — no other rule is touched.
 *   - margin_top_mm/margin_bottom_mm/margin_left_mm/margin_right_mm: set to
 *     the canonical default 10/10/12/12 (html-renderer.ts's
 *     DEFAULT_PAGE_MARGINS).
 *   - status DRAFT, mapping_snapshot [] (same "resolve current mapping"
 *     semantics every other clone/new-version gets — see
 *     selectPreviewMappings), published_at/archived_at NULL.
 *
 * Idempotent: a second run finds the DRAFT it already created (same
 * html_body, print_css with no @page, margins already 10/10/12/12) and
 * skips re-creating it.
 *
 * Cách dùng:
 *   DATABASE_URL=postgres://... node scripts/audit-remediate-published-template-margins.mjs
 *
 * Output: one JSON line per template to stdout (NDJSON — single-line
 * JSON.stringify, no pretty-print, matching the repo's existing diagnostic
 * script convention so a downstream step can parse line-by-line).
 */
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
  process.exit(1);
}
// Opt-in only: full html_body/print_css are template content (placeholders
// like <<Ho_ten>>, never candidate data), but are large — keep default runs
// lean and only include them when explicitly requested for offline
// (local, non-production) render verification of a remediation. GitHub
// Actions' `type: boolean` workflow_dispatch inputs arrive as the literal
// string "true"/"false" (not "1"/"0"), so accept both spellings.
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

const AT_PAGE_RULE = /@page\s*\{[^}]*\}/g;
const DEFAULT_MARGINS = { top: 10, bottom: 10, left: 12, right: 12 };

const { rows: templates } = await client.query(
  `SELECT id, name, current_published_version, html_enabled
   FROM merge_templates
   WHERE current_published_version IS NOT NULL`,
);

for (const tpl of templates) {
  const { rows: publishedRows } = await client.query(
    `SELECT id, version, html_body, print_css, margin_top_mm, margin_bottom_mm, margin_left_mm, margin_right_mm, source_docx_name
     FROM merge_template_versions
     WHERE template_id = $1 AND version = $2 AND status = 'PUBLISHED'
     LIMIT 1`,
    [tpl.id, tpl.current_published_version],
  );
  const published = publishedRows[0];

  if (!published) {
    console.log(
      JSON.stringify({
        event: "audit_error",
        templateId: tpl.id,
        templateName: tpl.name,
        error: "PUBLISHED row not found for current_published_version (pointer/version mismatch)",
      }),
    );
    continue;
  }

  const printCss = published.print_css ?? "";
  const atPageRules = [...printCss.matchAll(AT_PAGE_RULE)].map((m) => m[0]);
  const hasAtPage = atPageRules.length > 0;

  const auditEvent = {
    event: "audit",
    templateId: tpl.id,
    templateName: tpl.name,
    htmlEnabled: tpl.html_enabled,
    publishedVersionId: published.id,
    publishedVersion: published.version,
    sourceDocxName: published.source_docx_name,
    currentMargins: {
      top: published.margin_top_mm,
      bottom: published.margin_bottom_mm,
      left: published.margin_left_mm,
      right: published.margin_right_mm,
    },
    legacyAtPageFound: hasAtPage,
    legacyAtPageRules: atPageRules,
    htmlBodyLength: (published.html_body ?? "").length,
    printCssLength: printCss.length,
  };
  console.log(JSON.stringify(auditEvent));

  if (!hasAtPage) {
    console.log(
      JSON.stringify({
        event: "remediation",
        templateId: tpl.id,
        publishedVersion: published.version,
        action: "NOT_NEEDED",
        reason: "print_css already carries no @page rule — canonical @page:0 baseline applies uncontested.",
      }),
    );
    continue;
  }

  // Strip ONLY @page {...} block(s) — nothing else in the CSS is touched.
  const remediatedCss = printCss.replace(AT_PAGE_RULE, "").trim();

  if (DUMP_CONTENT) {
    console.log(
      JSON.stringify({
        event: "content_dump",
        templateId: tpl.id,
        publishedVersion: published.version,
        publishedHtmlBody: published.html_body,
        publishedPrintCss: printCss,
        remediatedPrintCss: remediatedCss,
      }),
    );
  }

  const { rows: existingDrafts } = await client.query(
    `SELECT id, version FROM merge_template_versions
     WHERE template_id = $1 AND status = 'DRAFT' AND html_body = $2 AND print_css = $3
       AND margin_top_mm = $4 AND margin_bottom_mm = $5 AND margin_left_mm = $6 AND margin_right_mm = $7
     ORDER BY version DESC
     LIMIT 1`,
    [tpl.id, published.html_body, remediatedCss, DEFAULT_MARGINS.top, DEFAULT_MARGINS.bottom, DEFAULT_MARGINS.left, DEFAULT_MARGINS.right],
  );

  if (existingDrafts.length > 0) {
    console.log(
      JSON.stringify({
        event: "remediation",
        templateId: tpl.id,
        publishedVersion: published.version,
        action: "ALREADY_EXISTS",
        newDraftVersionId: existingDrafts[0].id,
        newDraftVersion: existingDrafts[0].version,
      }),
    );
    continue;
  }

  const {
    rows: [{ max_version: maxVersion }],
  } = await client.query(`SELECT COALESCE(MAX(version), 0) AS max_version FROM merge_template_versions WHERE template_id = $1`, [
    tpl.id,
  ]);
  const nextVersion = Number(maxVersion) + 1;

  const {
    rows: [inserted],
  } = await client.query(
    `INSERT INTO merge_template_versions
       (template_id, version, status, html_body, print_css, source_docx_name,
        retention_years, margin_top_mm, margin_bottom_mm, margin_left_mm, margin_right_mm,
        mapping_snapshot, created_by, published_at, archived_at)
     SELECT template_id, $2, 'DRAFT', html_body, $3, source_docx_name,
            retention_years, $4, $5, $6, $7, '[]'::jsonb,
            'system-margin-remediation', NULL, NULL
     FROM merge_template_versions WHERE id = $1
     RETURNING id, version`,
    [published.id, nextVersion, remediatedCss, DEFAULT_MARGINS.top, DEFAULT_MARGINS.bottom, DEFAULT_MARGINS.left, DEFAULT_MARGINS.right],
  );

  console.log(
    JSON.stringify({
      event: "remediation",
      templateId: tpl.id,
      publishedVersion: published.version,
      action: "CREATED",
      newDraftVersionId: inserted.id,
      newDraftVersion: inserted.version,
      note: "New DRAFT only — PUBLISHED version untouched, not auto-published.",
    }),
  );
}

await client.end();
