#!/usr/bin/env node
/**
 * DIAGNOSE — DW cũ (Tài liệu A) checkbox/option fields vs DW mới (Tài liệu B).
 *
 * READ-ONLY, SELECT only. Never writes anything. Never selects candidate
 * data (no daily_applications join, no source_record_id) — only template
 * configuration: merge_templates / merge_template_versions / merge_template_fields
 * rows, which contain placeholders (e.g. <<Ket_hon>>) and mapping metadata,
 * never a real candidate's values.
 *
 * For each of the two dual-template-routing templates (document_kind 'A' =
 * DW Cũ, 'B' = DW Mới — see template-routing.ts's DOCUMENT_KIND_META), reads:
 *   - merge_templates row (name, googleDocId, currentPublishedVersion, htmlEnabled)
 *   - EVERY merge_template_versions row (version/status/margins/mapping_snapshot
 *     length) so both the PUBLISHED and any newer DRAFT are visible
 *   - every merge_template_fields row (placeholder/sourceType/sourceField/
 *     sourcePath/optionValue/formatType/isOrphaned) — the live mapping, which
 *     is what actually drives BOOLEAN_CHECKBOX rendering at merge time
 *   - for the html_body of the PUBLISHED version (and the latest DRAFT, if
 *     different from PUBLISHED): a bounded snippet around every placeholder
 *     token found near "Không"/"Có" text or an existing ☐/☒ glyph, so the
 *     exact markup difference around checkbox fields is visible WITHOUT
 *     dumping the entire (large) html_body.
 *
 * Cách dùng:
 *   DATABASE_URL=postgres://... node scripts/diagnose-dw-cu-checkbox-fields.mjs
 *
 * Output: one JSON line per event to stdout (NDJSON, matching this repo's
 * existing diagnostic script convention).
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

/** Bounded snippet around every placeholder token near Không/Có text or an existing checkbox glyph. */
function extractCheckboxSnippets(html) {
  const body = html ?? "";
  const snippets = [];
  // A) explicit ☐ / ☒ glyphs already present (DW mới's known-good rendering
  //    trace — helps confirm those are runtime output, not hardcoded, by
  //    their absence from html_body; anything found here IS hardcoded).
  const glyphRe = /[☐☒]/g;
  let m;
  while ((m = glyphRe.exec(body)) !== null) {
    snippets.push({ kind: "glyph_literal_in_html", index: m.index, context: body.slice(Math.max(0, m.index - 80), m.index + 80) });
  }
  // B) "Không" / "Có" option-label text near a <<placeholder>> — the
  //    checkbox-field markup pattern itself, wherever it lives.
  const labelRe = /(Không|Có)[\s\S]{0,60}?(<<\s*[^<>]+?\s*>>)|(<<\s*[^<>]+?\s*>>)[\s\S]{0,60}?(Không|Có)/g;
  while ((m = labelRe.exec(body)) !== null) {
    snippets.push({ kind: "checkbox_label_near_placeholder", index: m.index, context: body.slice(Math.max(0, m.index - 60), m.index + 140) });
  }
  return snippets;
}

const { rows: templates } = await client.query(
  `SELECT id, name, document_kind, google_doc_id, current_published_version, html_enabled, is_active
   FROM merge_templates
   WHERE document_kind IN ('A', 'B')
   ORDER BY document_kind`,
);

for (const tpl of templates) {
  console.log(
    JSON.stringify({
      event: "template",
      templateId: tpl.id,
      name: tpl.name,
      documentKind: tpl.document_kind,
      googleDocId: tpl.google_doc_id,
      isActive: tpl.is_active,
      htmlEnabled: tpl.html_enabled,
      currentPublishedVersion: tpl.current_published_version,
    }),
  );

  const { rows: versions } = await client.query(
    `SELECT id, version, status, source_docx_name, margin_top_mm, margin_bottom_mm, margin_left_mm, margin_right_mm,
            length(html_body) AS html_body_length, length(print_css) AS print_css_length,
            jsonb_array_length(COALESCE(mapping_snapshot, '[]'::jsonb)) AS mapping_snapshot_count,
            html_body, print_css
     FROM merge_template_versions
     WHERE template_id = $1
     ORDER BY version DESC`,
    [tpl.id],
  );

  for (const v of versions) {
    console.log(
      JSON.stringify({
        event: "version",
        templateId: tpl.id,
        documentKind: tpl.document_kind,
        version: v.version,
        status: v.status,
        sourceDocxName: v.source_docx_name,
        margins: { top: v.margin_top_mm, bottom: v.margin_bottom_mm, left: v.margin_left_mm, right: v.margin_right_mm },
        htmlBodyLength: v.html_body_length,
        printCssLength: v.print_css_length,
        mappingSnapshotCount: v.mapping_snapshot_count,
      }),
    );

    // Only PUBLISHED + the single latest version get the (bounded) snippet
    // scan — avoids scanning/printing every historical DRAFT.
    const isLatest = v.version === versions[0].version;
    if (v.status === "PUBLISHED" || isLatest) {
      const snippets = extractCheckboxSnippets(v.html_body);
      console.log(
        JSON.stringify({
          event: "checkbox_snippets",
          templateId: tpl.id,
          documentKind: tpl.document_kind,
          version: v.version,
          status: v.status,
          snippetCount: snippets.length,
          snippets,
        }),
      );
    }
  }

  const { rows: fields } = await client.query(
    `SELECT placeholder, source_type, source_entity, source_field, source_path, option_value, format_type,
            fallback_value, is_required, is_orphaned, is_suggested
     FROM merge_template_fields
     WHERE template_id = $1
     ORDER BY placeholder`,
    [tpl.id],
  );
  console.log(
    JSON.stringify({
      event: "fields",
      templateId: tpl.id,
      documentKind: tpl.document_kind,
      fieldCount: fields.length,
      fields: fields.map((f) => ({
        placeholder: f.placeholder,
        sourceType: f.source_type,
        sourceEntity: f.source_entity,
        sourceField: f.source_field,
        sourcePath: f.source_path,
        optionValue: f.option_value,
        formatType: f.format_type,
        fallbackValue: f.fallback_value,
        isRequired: f.is_required,
        isOrphaned: f.is_orphaned,
        isSuggested: f.is_suggested,
      })),
    }),
  );

  // Highlight specifically: fields using BOOLEAN_CHECKBOX in EITHER template
  // — the exact mapping mechanism DW mới presumably uses and DW cũ should
  // reuse verbatim for the equivalent placeholder.
  const checkboxFields = fields.filter((f) => f.format_type === "BOOLEAN_CHECKBOX");
  console.log(
    JSON.stringify({
      event: "boolean_checkbox_fields",
      templateId: tpl.id,
      documentKind: tpl.document_kind,
      count: checkboxFields.length,
      placeholders: checkboxFields.map((f) => f.placeholder),
    }),
  );
}

await client.end();
console.log(JSON.stringify({ event: "done" }));
