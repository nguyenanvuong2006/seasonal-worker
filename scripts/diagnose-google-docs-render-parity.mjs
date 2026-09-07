#!/usr/bin/env node
/**
 * DIAGNOSE GOOGLE_DOCS RENDER PARITY — READ-ONLY, PRODUCTION-SAFE.
 *
 * Empirical evidence for the PREVIEW vs REAL-MERGE geometry divergence
 * investigation (2026-09): proves, from REAL stored production data (not
 * code inference alone), that:
 *
 *   1. A real GOOGLE_DOCS merge_jobs row's frozen metadata.templates[...]
 *      snapshot does NOT carry usable page-margin data for the worker (the
 *      worker's GoogleDocsTemplateSnapshot type has no margin fields — see
 *      worker/src/index.ts — so even though async-job.ts happens to copy
 *      htmlBody/printCss into the GOOGLE_DOCS metadata shape, the worker
 *      never reads them; runGoogleDocsItem() fetches the LIVE Google Doc
 *      content via service.getDocumentContent(tpl.googleDocId) instead).
 *   2. The actual Google Doc identified by the template's googleDocId has
 *      its OWN native documentStyle (page margins / size) — configured
 *      independently of merge_template_versions.margin_top_mm etc. — which
 *      is what a real GOOGLE_DOCS merge's copied output actually inherits.
 *
 * SELECT-only against merge_jobs/merge_templates (no PII: never selects
 * merge_job_records.source_record_id or joins daily_applications). The
 * Google Docs API call is a read-only documents.get restricted to the
 * documentStyle field mask — never reads body.content (candidate-adjacent
 * template body text), never writes anything.
 *
 * Cách dùng:
 *   DATABASE_URL=postgres://... \
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... \
 *   node scripts/diagnose-google-docs-render-parity.mjs
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

// 1) Most recent GOOGLE_DOCS-engine job — metadata.templates shape only,
// never a candidate-identifying column.
const { rows: jobs } = await client.query(
  `SELECT id, status, engine, created_at, metadata
   FROM merge_jobs
   WHERE engine = 'GOOGLE_DOCS'
   ORDER BY created_at DESC
   LIMIT 1`,
);

if (jobs.length === 0) {
  console.log(JSON.stringify({ event: "no_google_docs_job_found" }));
} else {
  const job = jobs[0];
  const templates = job.metadata?.templates ?? {};
  const report = Object.entries(templates).map(([tid, snap]) => ({
    templateId: tid,
    version: snap.version ?? null,
    googleDocId: snap.googleDocId ? `${String(snap.googleDocId).slice(0, 8)}…` : null,
    hasHtmlBodyInMetadata: typeof snap.htmlBody === "string" && snap.htmlBody.length > 0,
    hasPrintCssInMetadata: typeof snap.printCss === "string" && snap.printCss.length > 0,
    hasMarginsInMetadata: snap.margins != null,
  }));
  console.log(
    JSON.stringify({
      event: "real_google_docs_job_snapshot",
      jobId: job.id,
      status: job.status,
      createdAt: job.created_at,
      templates: report,
      note:
        "hasMarginsInMetadata=false confirms the GOOGLE_DOCS job metadata carries no margin data — the worker's " +
        "GoogleDocsTemplateSnapshot type (worker/src/index.ts) declares no margin fields and never reads any that " +
        "were present, so this is true regardless of the boolean above.",
    }),
  );
}

// 2) The template's googleDocId's OWN native page setup — read-only, field
// mask restricted to documentStyle only (never body.content).
const { rows: templates } = await client.query(
  `SELECT id, name, google_doc_id FROM merge_templates WHERE google_doc_id IS NOT NULL LIMIT 5`,
);

async function getAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const json = await response.json();
  return json.access_token ?? null;
}

const accessToken = await getAccessToken();
if (!accessToken) {
  console.log(JSON.stringify({ event: "google_oauth_unavailable", note: "skipping live documentStyle read" }));
} else {
  for (const tpl of templates) {
    try {
      const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(tpl.google_doc_id)}?fields=documentStyle`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) {
        const detail = await response.text();
        console.log(
          JSON.stringify({ event: "google_doc_style_read_failed", templateId: tpl.id, status: response.status, detail: detail.slice(0, 300) }),
        );
        continue;
      }
      const doc = await response.json();
      const ds = doc.documentStyle ?? {};
      const emuToMm = (emu) => (typeof emu?.magnitude === "number" ? (emu.magnitude / 914400) * 25.4 : null);
      console.log(
        JSON.stringify({
          event: "google_doc_native_page_style",
          templateId: tpl.id,
          templateName: tpl.name,
          pageSizeMm: { width: emuToMm(ds.pageSize?.width), height: emuToMm(ds.pageSize?.height) },
          marginsMm: {
            top: emuToMm(ds.marginTop),
            bottom: emuToMm(ds.marginBottom),
            left: emuToMm(ds.marginLeft),
            right: emuToMm(ds.marginRight),
          },
          note: "This is the SOURCE Google Doc's own native page setup — completely independent of merge_template_versions.margin_top_mm etc. A real GOOGLE_DOCS merge copies this Doc verbatim (Drive files.copy) and inherits this exact geometry.",
        }),
      );
    } catch (error) {
      console.log(JSON.stringify({ event: "google_doc_style_read_error", templateId: tpl.id, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
    }
  }
}

await client.end();
