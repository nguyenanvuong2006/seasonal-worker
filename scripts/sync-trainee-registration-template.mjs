#!/usr/bin/env node
/**
 * CANONICAL SOURCE → DRAFT DATABASE VERSION (authoring tool, build-time only).
 *
 * This script no longer generates a runtime TypeScript module. Emitting the
 * document body into `src/` is exactly what allowed an obsolete template to
 * survive as a runtime fallback, so the generated module has been removed.
 *
 * What this script produces:
 *   1. migrations/2026-08-23-trainee-registration-canonical-html-draft.sql
 *      → inserts ONE new DRAFT version of merge_template_versions.
 *      → never publishes, never sets current_published_version,
 *        never flips html_enabled, never overwrites a historical version.
 *   2. templates/document-merge/trainee-registration/canonical-source.manifest.json
 *      → checksum/structure manifest used by tests. Metadata only, no body.
 *
 * The document body reaches runtime ONLY through the database, and only after
 * an operator explicitly Publishes the draft.
 *
 * Usage:
 *   node scripts/sync-trainee-registration-template.mjs
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_RELATIVE = "templates/document-merge/trainee-registration/canonical-source.html";
const sourcePath = join(ROOT, SOURCE_RELATIVE);
const manifestPath = join(ROOT, "templates", "document-merge", "trainee-registration", "canonical-source.manifest.json");
const migrationPath = join(ROOT, "migrations", "2026-08-23-trainee-registration-canonical-html-draft.sql");

const SOURCE_DOCX_NAME =
  "trainee-registration/canonical-source.html (canonical HTML; preview UI stripped)";

// The exact checkbox semantic fields in the reviewed contract. They render as
// ☒/☐ via the existing CHECKBOX_OPTION resolver and base `.chk` CSS.
const CHECKBOX_PLACEHOLDERS = new Set([
  "Tien_an_tien_su_Khong", "Tien_an_tien_su_Co",
  "Da_tung_lam_DHF_Khong", "Da_tung_lam_DHF_Co",
  "Loai_cong_viec_Nhan_vien", "Loai_cong_viec_Cong_nhan", "Loai_cong_viec_Lao_dong_tap_nghe",
  "Khu_vuc_Da_Lat", "Khu_vuc_Da_Quy", "Khu_vuc_Da_Ron", "Khu_vuc_Lam_Ha", "Khu_vuc_Khac",
  "Cong_viec_hien_tai_Sinh_vien", "Cong_viec_hien_tai_Khac",
  "TKNH_Da_co", "TKNH_Chua_co",
  "Thu_nhap_Chi_DHF", "Thu_nhap_Ngoai_DHF",
  "Tap_nghe_Trong_cham_soc_thu_hoach", "Tap_nghe_Ban_hang", "Tap_nghe_Dong_goi", "Tap_nghe_Khac",
]);

function extractStyle(source) {
  const match = source.match(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/i);
  if (!match) throw new Error("Canonical source is missing a <style> block.");
  return match[1].trim();
}

function classList(openTag) {
  const classMatch = openTag.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
  return classMatch ? classMatch[2].trim().split(/\s+/) : [];
}

/**
 * Return exact outer HTML for each top-level .page div.
 *
 * NOTE: the number of pages is DERIVED from the source; it is never asserted
 * against a hard-coded expectation. If the approved document later has 3, 5, 7
 * or N pages, this script follows it.
 */
function extractPageBlocks(source) {
  const pages = [];
  const opening = /<div\b[^>]*>/gi;
  let openMatch;
  while ((openMatch = opening.exec(source))) {
    if (!classList(openMatch[0]).includes("page")) continue;

    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = openMatch.index;
    let depth = 0;
    let tag;
    while ((tag = tags.exec(source))) {
      if (/^<\/div\b/i.test(tag[0])) depth -= 1;
      else depth += 1;
      if (depth === 0) {
        pages.push(source.slice(openMatch.index, tags.lastIndex));
        break;
      }
    }
    if (depth !== 0) throw new Error(`Unclosed .page block beginning at byte ${openMatch.index}.`);
    opening.lastIndex = tags.lastIndex;
  }
  if (pages.length === 0) throw new Error("Canonical source contains no .page sections.");
  return pages;
}

function semanticizeFieldMarkers(pageHtml) {
  return pageHtml.replace(
    /<span\s+class=(["'])f\1>\s*\{\{\s*([^{}]+?)\s*\}\}\s*<\/span>/g,
    (_whole, _quote, rawKey) => {
      const key = rawKey.trim();
      const className = CHECKBOX_PLACEHOLDERS.has(key) ? "chk" : "merge-value";
      return `<span class="${className}">{{${key}}}</span>`;
    },
  );
}

const source = readFileSync(sourcePath, "utf8");
const pageBlocks = extractPageBlocks(source);
const html = pageBlocks.map(semanticizeFieldMarkers).join("\n\n");

/**
 * Print lock: keep the approved typography/layout but compact vertical
 * whitespace in print media only. No transforms/zoom, no tiny text; long merge
 * values still wrap safely. Page COUNT is not forced here — `.page` sections
 * simply break, however many the canonical body defines.
 */
const css = `${extractStyle(source)}

/* Production merge normalisation: no editor styling, safe long-value wrapping. */
@media print {
  .page {
    box-shadow: none;
    margin: 0;
    width: 210mm;
    min-height: 297mm;
    padding: 8mm 14mm;
    overflow: visible;
    break-after: page;
    page-break-after: always;
    break-inside: avoid;
    page-break-inside: avoid;
    font-size: 10.5pt;
    line-height: 1.15;
  }

  .page:last-child {
    break-after: auto;
    page-break-after: auto;
  }

  /* Preserve visual hierarchy while removing preview-style vertical slack. */
  .doc-header { margin-bottom: 3mm; }
  .doc-header .hd-left { padding-top: 2mm; padding-bottom: 2mm; }
  .doc-header .hd-right { padding-top: 2.2mm; padding-bottom: 2.2mm; }

  .line { margin-bottom: 1.1mm; }
  .tight { margin-bottom: 0.35mm; }
  .sec { margin: 1.2mm 0 0.7mm; }

  .mt2 { margin-top: 1mm; }
  .mt4 { margin-top: 2mm; }
  .mt6 { margin-top: 3mm; }
  .mt8 { margin-top: 4mm; }
  .mt10 { margin-top: 5mm; }
  .mt14 { margin-top: 7mm; }
  .mt20 { margin-top: 10mm; }

  .attach-box {
    padding: 1.4mm 3mm;
    margin: 2mm 0 4mm;
  }
  .attach-box td { padding: 0.25mm 0; }

  .sign-3-table { margin-top: 2mm; }
  .sign-gap { height: 11mm; }

  .photo-wrap .body-col { min-width: 0; }
  .merge-value {
    overflow-wrap: anywhere;
    word-break: normal;
  }

  .attach-box,
  .sign-single,
  .sign-3-table {
    break-inside: avoid;
    page-break-inside: avoid;
  }
}`;

const sourceHash = createHash("sha256").update(source).digest("hex");
const bodyHash = createHash("sha256").update(html).digest("hex");
const placeholders = [...new Set([...html.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))].sort();

/** Manifest = metadata only. It intentionally contains NO document body. */
const manifest = {
  note: "Metadata only. The document body lives exclusively in merge_template_versions after an explicit Publish.",
  sourcePath: SOURCE_RELATIVE,
  sourceSha256: sourceHash,
  canonicalBodySha256: bodyHash,
  logicalPageCount: pageBlocks.length,
  placeholderCount: placeholders.length,
  placeholders,
  sourceDocxName: SOURCE_DOCX_NAME,
  generatedBy: "scripts/sync-trainee-registration-template.mjs",
};

const migration = `-- ============================================================
-- CANONICAL TRAINEE-REGISTRATION HTML — DRAFT ONLY
-- ------------------------------------------------------------
-- Source: ${SOURCE_RELATIVE}
-- Source SHA-256: ${sourceHash}
-- Canonical body SHA-256: ${bodyHash}
-- Logical .page sections: ${pageBlocks.length} (derived from the source, not enforced)
--
-- This migration is idempotent and non-destructive. It adds one new DRAFT
-- version only; it does not publish, set current_published_version, change
-- html_enabled, create jobs, or activate HTML_PDF in any environment.
--
-- Historical versions are preserved for audit/rollback and are never updated
-- or deleted here. Runtime NEVER falls back to a historical version: the
-- render pipeline requires an explicitly PUBLISHED canonical version.
-- ============================================================
WITH target_template AS (
  SELECT id
  FROM merge_templates
  WHERE google_doc_id = '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE'
  ORDER BY created_at ASC
  LIMIT 1
), next_version AS (
  SELECT t.id AS template_id, COALESCE(MAX(v.version), 0) + 1 AS version
  FROM target_template t
  LEFT JOIN merge_template_versions v ON v.template_id = t.id
  GROUP BY t.id
)
INSERT INTO merge_template_versions (
  template_id, version, status, html_body, print_css, source_docx_name,
  retention_years, mapping_snapshot, created_by, created_at, updated_at
)
SELECT
  n.template_id,
  n.version,
  'DRAFT',
  $canonical_html$${html}$canonical_html$,
  $canonical_css$${css}$canonical_css$,
  '${SOURCE_DOCX_NAME}',
  3,
  '[]'::jsonb,
  'system',
  now(),
  now()
FROM next_version n
WHERE NOT EXISTS (
  SELECT 1
  FROM merge_template_versions existing
  WHERE existing.template_id = n.template_id
    AND existing.source_docx_name = '${SOURCE_DOCX_NAME}'
);

-- Post-apply verification (read-only): must report one DRAFT, zero PUBLISHED.
SELECT version, status, source_docx_name
FROM merge_template_versions
WHERE source_docx_name = '${SOURCE_DOCX_NAME}';
`;

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeFileSync(migrationPath, migration, "utf8");
console.log(`Generated ${manifestPath}`);
console.log(`Generated ${migrationPath}`);
console.log(`Canonical source SHA-256: ${sourceHash}`);
console.log(`Logical pages (derived): ${pageBlocks.length}`);
console.log(`Placeholders: ${placeholders.length}`);
