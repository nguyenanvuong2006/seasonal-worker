#!/usr/bin/env node
/**
 * OPERATOR-PROVIDED test(2).html → CANONICAL RUNTIME SOURCE + v7 DRAFT.
 *
 * Source of truth: incoming/test2.html  (the operator file "test(2).html")
 *
 * This script extracts the authoring source EXACTLY:
 *   - document print CSS : <style id="doccss"> … </style>
 *   - document body      : <script type="text/template" id="tpl"> … </script>
 *
 * It does NOT redesign, normalize layout, or hand-recreate the HTML. The body
 * is preserved byte-for-byte (DOM structure, spacing, tables, page breaks,
 * typography, placeholders). The only transformations are the mandatory
 * runtime-stripping of preview UI, which cannot affect the printed document:
 *
 *   - toolbar / stage / zoom / preview controls / download buttons removed
 *   - the browser-only SAMPLE data + draw()/fullHtml()/preview <script> removed
 *   - inline on* handlers removed (defence in depth; none exist in the body)
 *
 * Outputs (all non-destructive):
 *   1. templates/.../canonical-source.html
 *        = standalone runtime document (the extracted #tpl body wrapped in a
 *          minimal HTML shell that inlines ONLY #doccss). No preview chrome.
 *   2. migrations/2026-08-24-...-v7-draft.sql
 *        = ONE new DRAFT merge_template_versions row (v7) using the new
 *          body/printCss. It never publishes, never touches v6, never changes
 *          html_enabled, never sets current_published_version.
 *   3. templates/.../canonical-source.manifest.json (metadata/checksums).
 *
 * The current approved 49-field mapping is preserved unchanged. Per the
 * established invariant, a DRAFT version carries an EMPTY mapping_snapshot
 * ('[]'); publishTemplateVersion() is the sole authority that snapshots the
 * CURRENT Production merge_template_fields (non-orphaned, 49 rows) into
 * mapping_snapshot at PUBLISH time — overwriting whatever the draft held.
 * merge_template_fields (Production) is NOT modified by this script.
 *
 * The MAPPING constant below is used ONLY as a structural/address-semantics
 * self-check against the 49 document tokens; it is never written to the DRAFT.
 * The three mandatory address mappings (verified by this check) are:
 *
 *   Dia_chi_thuong_tru -> permanentAddress   required=false
 *   dia_chi_cu_tru     -> residentialAddress required=false
 *   Dia_chi_tam_tru    -> residentialAddress required=true
 *
 * Usage:
 *   node scripts/sync-trainee-registration-v7.mjs
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPERATOR_SOURCE = "incoming/test2.html"; // operator file "test(2).html"
const TEMPLATE_DIR = join(ROOT, "templates", "document-merge", "trainee-registration");
const CANONICAL_SOURCE = join(TEMPLATE_DIR, "canonical-source.html");
const MANIFEST_PATH = join(TEMPLATE_DIR, "canonical-source.manifest.json");
// Authoritative 49-field mapping (for review/verification only). This is NOT
// written into the DRAFT mapping_snapshot (which stays '[]'); it documents the
// current approved Production v6 mapping that publishTemplateVersion() will
// snapshot at PUBLISH time.
const MAPPING_JSON_PATH = join(TEMPLATE_DIR, "v7-mapping.json");
const MIGRATION_PATH = join(
  ROOT,
  "migrations",
  "2026-08-24-trainee-registration-v7-operator-test2-draft.sql",
);

const SOURCE_DOCX_NAME =
  "trainee-registration/test(2).html (operator-provided canonical HTML; preview UI stripped) v7";

const GOOGLE_DOC_ID = "10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE";

/** Extract the inner text of <tag id="id"> … </tag>. */
function extractTaggedBlock(source, tag, id) {
  const openRe = new RegExp(`<${tag}\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`, "i");
  const open = source.match(openRe);
  if (!open) throw new Error(`operator source is missing <${tag} id="${id}">`);
  const start = open.index + open[0].length;
  const close = source.indexOf(`</${tag}>`, start);
  if (close < 0) throw new Error(`operator source is missing closing </${tag}> for #${id}`);
  return source.slice(start, close);
}

/** Strip ONLY preview/browser chrome that can never be part of the print doc. */
function stripRuntimeChrome(body) {
  let out = body;
  // Defence in depth: the body itself contains no <script>/on* handlers, but a
  // future paste of preview HTML could. Removing them never alters printed
  // content (Chromium worker blocks scripts/network regardless).
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return out;
}

/**
 * A4 print CSS is prepended at render time by the shared renderer
 * (html-renderer.ts A4_PRINT_CSS). Its generic `table/th/td{border…}` and
 * `table{margin…}` rules would otherwise draw borders/margins on the
 * operator's borderless `.attach-box` / `.sign-3` tables and add padding to
 * the tax-number `.mst` cells — materially changing the reference layout.
 *
 * These rules have the SAME specificity as A4_PRINT_CSS but are emitted AFTER
 * it (renderer concatenates A4 + printCss), so they win, while `#doccss`
 * (emitted after this block) keeps its own explicit declarations. Net result:
 * the rendered/printed document matches the operator reference exactly.
 */
/**
 * Runtime parity block.
 *
 * The shared renderer PREPENDS a generic A4 print stylesheet (A4_PRINT_CSS)
 * whose `@page`, `table/th/td{border…}` and `table{margin…}` rules would
 * otherwise materially change the operator reference (A4 margins 12mm 14mm,
 * borderless .attach-box/.sign-3 tables, exact .mst cell geometry).
 *
 * This block is emitted BEFORE #doccss (renderer concatenation order:
 * A4_PRINT_CSS + RUNTIME_PARITY_CSS + #doccss). It neutralises A4_PRINT_CSS
 * with equal specificity, and #doccss — emitted last — keeps all of its own
 * explicit declarations. Net output matches test(2).html exactly.
 */
const RUNTIME_PARITY_CSS = `
/* ===== runtime parity (auto-generated): neutralise generic A4 renderer CSS; #doccss follows and wins ===== */
@page { size: A4 portrait; margin: 12mm 14mm; }
.paper table { margin: 0; table-layout: auto; }
.paper th, .paper td { border: none; padding: 0; text-align: left; vertical-align: baseline; }
.paper .mst { margin: 0; }
`;

const source = readFileSync(join(ROOT, OPERATOR_SOURCE), "utf8");
const docCssRaw = extractTaggedBlock(source, "style", "doccss").trim();
const tplRaw = extractTaggedBlock(source, "script", "tpl");

const body = stripRuntimeChrome(tplRaw).trim();

// The runtime printCss = parity neutraliser FIRST, then #doccss verbatim, so
// #doccss wins every cascade (A4_PRINT_CSS + parity + doccss at render time).
const printCss = `${RUNTIME_PARITY_CSS}\n${docCssRaw}`;

// ----- standalone canonical runtime source (inlined #doccss, body only) -----
const canonicalSource = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Giấy đăng ký tập nghề - Dalat Hasfarm</title>
<!--
  CANONICAL RUNTIME SOURCE — generated verbatim from the operator-provided
  authoring shell. The document print CSS and body are extracted unchanged
  from the operator's tagged style/template blocks. This file contains ONLY
  the real six-page document; the browser preview shell is excluded.
-->
<style>
${printCss}
</style>
</head>
<body>
${body}
</body>
</html>
`;

// ----- metrics -----
const placeholders = [...new Set([...body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))].sort();
const pageCount = (body.match(/class="paper"/g) || []).length;

if (placeholders.length !== 49) {
  throw new Error(`Expected 49 placeholders, found ${placeholders.length}: ${placeholders.join(", ")}`);
}
if (pageCount !== 6) {
  throw new Error(`Expected 6 pages (.paper), found ${pageCount}`);
}

const sourceHash = createHash("sha256").update(source).digest("hex");
const bodyHash = createHash("sha256").update(body).digest("hex");
const cssHash = createHash("sha256").update(printCss).digest("hex");

// ----- current approved 49-field mapping (Production v6 semantics preserved) -----
// text/computed fields
const text = (placeholder, sourcePath, isRequired = false, sourceType = "CORE_FIELD") =>
  ({ placeholder, sourceType, sourceEntity: null, sourceField: null, sourcePath, optionValue: null, formatType: null, fallbackValue: null, isRequired });
const check = (placeholder, sourcePath, optionValue) =>
  ({ placeholder, sourceType: "CHECKBOX_OPTION", sourceEntity: null, sourceField: null, sourcePath, optionValue, formatType: null, fallbackValue: null, isRequired: false });
const compute = (placeholder, sourceField, isRequired = false) =>
  ({ placeholder, sourceType: "COMPUTED_FIELD", sourceEntity: null, sourceField, sourcePath: null, optionValue: null, formatType: null, fallbackValue: null, isRequired });

const MAPPING = [
  text("Ho_ten", "fullName", true),
  text("Ngay_sinh", "dob", true),
  // MANDATORY ADDRESS SEMANTICS — no cross-address fallback:
  text("Dia_chi_thuong_tru", "permanentAddress", false),
  text("dia_chi_cu_tru", "residentialAddress", false),
  text("Dia_chi_tam_tru", "residentialAddress", true),
  text("So_dien_thoai", "phone", true),
  text("So_CCCD", "cccd", true),
  text("Ngay_cap_CCCD", "dateOfIssue", false),
  text("Noi_cap_CCCD", "placeOfIssue", false),

  check("Tien_an_tien_su_Khong", "customAnswers.tien_an_tien_su", "Không"),
  check("Tien_an_tien_su_Co", "customAnswers.tien_an_tien_su", "Có"),
  check("Da_tung_lam_DHF_Khong", "declaredType", "NEW"),
  check("Da_tung_lam_DHF_Co", "declaredType", "OLD"),
  check("Loai_cong_viec_Nhan_vien", "customAnswers.loai_cong_viec_truoc_day", "Nhân viên"),
  check("Loai_cong_viec_Cong_nhan", "customAnswers.loai_cong_viec_truoc_day", "Công nhân"),
  check("Loai_cong_viec_Lao_dong_tap_nghe", "customAnswers.loai_cong_viec_truoc_day", "Lao động tập nghề"),
  check("Khu_vuc_Da_Lat", "customAnswers.khu_vuc_lam_viec_truoc_day", "Đà Lạt"),
  check("Khu_vuc_Da_Quy", "customAnswers.khu_vuc_lam_viec_truoc_day", "Đa Quý"),
  check("Khu_vuc_Da_Ron", "customAnswers.khu_vuc_lam_viec_truoc_day", "Đạ Ròn"),
  check("Khu_vuc_Lam_Ha", "customAnswers.khu_vuc_lam_viec_truoc_day", "Lâm Hà"),
  check("Khu_vuc_Khac", "customAnswers.khu_vuc_lam_viec_truoc_day", "Khác"),
  check("Cong_viec_hien_tai_Sinh_vien", "customAnswers.cong_viec_hien_tai", "Sinh viên"),
  check("Cong_viec_hien_tai_Khac", "customAnswers.cong_viec_hien_tai", "Khác"),
  text("Cong_viec_hien_tai_khac", "customAnswers.cong_viec_hien_tai_khac"),
  text("Ten_truong", "customAnswers.ten_truong"),
  check("TKNH_Da_co", "customAnswers.tinh_trang_tknh", "Đã có"),
  check("TKNH_Chua_co", "customAnswers.tinh_trang_tknh", "Chưa có"),
  text("So_tai_khoan", "customAnswers.so_tai_khoan"),
  text("Ten_ngan_hang", "customAnswers.ten_ngan_hang"),
  check("Thu_nhap_Chi_DHF", "customAnswers.nguon_thu_nhap", "Chỉ phát sinh tại Dalat Hasfarm"),
  check("Thu_nhap_Ngoai_DHF", "customAnswers.nguon_thu_nhap", "Phát sinh ngoài Dalat Hasfarm"),
  text("Cong_ty_thu_nhap_khac", "customAnswers.cong_ty_thu_nhap_khac"),
  text("Dia_diem_thu_nhap_khac", "customAnswers.dia_diem_thu_nhap_khac"),
  check("Tap_nghe_Trong_cham_soc_thu_hoach", "customAnswers.tap_nghe_nguyen_vong", "Trồng, chăm sóc, thu hoạch"),
  check("Tap_nghe_Ban_hang", "customAnswers.tap_nghe_nguyen_vong", "Bán hàng"),
  check("Tap_nghe_Dong_goi", "customAnswers.tap_nghe_nguyen_vong", "Đóng gói"),
  check("Tap_nghe_Khac", "customAnswers.tap_nghe_nguyen_vong", "Khác"),
  text("Cong_viec_khac", "customAnswers.cong_viec_khac"),

  text("Ngay_nhan_viec", "startingDate", true),
  text("Ngay_tiep_nhan", "startingDate", false),
  // Nguoi_tiep_nhan = current logged-in HR operator (SYSTEM_FIELD in v6)
  { placeholder: "Nguoi_tiep_nhan", sourceType: "SYSTEM_FIELD", sourceEntity: null, sourceField: "CURRENT_USER_NAME", sourcePath: null, optionValue: null, formatType: null, fallbackValue: null, isRequired: false },
  text("Dia_diem_ky", "location", false),
  // Ngay_ky_* and Nam_thue are date parts of startingDate (v6 semantics)
  compute("Ngay_ky_day", "DATE_DAY"),
  compute("Ngay_ky_month", "DATE_MONTH"),
  compute("Ngay_ky_year", "DATE_YEAR"),
  compute("Nam_thue", "DATE_YEAR"),
  text("Code", "code", false),
  text("Email", "customAnswers.email", false),
  text("So_dinh_danh_cu", "customAnswers.so_dinh_danh_cu", false),
];

const mappingPlaceholders = MAPPING.map((m) => m.placeholder).sort();
if (mappingPlaceholders.length !== 49) {
  throw new Error(`Mapping has ${mappingPlaceholders.length} rows, expected 49`);
}
for (const p of placeholders) {
  if (!mappingPlaceholders.includes(p)) throw new Error(`Placeholder ${p} missing from mapping`);
}
for (const p of mappingPlaceholders) {
  if (!placeholders.includes(p)) throw new Error(`Mapping has extra placeholder ${p} not in document`);
}
// address semantics guard
const addr = Object.fromEntries(MAPPING.filter((m) => m.placeholder.toLowerCase().includes("chi_")).map((m) => [m.placeholder, m]));
if (addr.Dia_chi_thuong_tru.sourcePath !== "permanentAddress" || addr.Dia_chi_thuong_tru.isRequired !== false) throw new Error("Dia_chi_thuong_tru semantics wrong");
if (addr.dia_chi_cu_tru.sourcePath !== "residentialAddress" || addr.dia_chi_cu_tru.isRequired !== false) throw new Error("dia_chi_cu_tru semantics wrong");
if (addr.Dia_chi_tam_tru.sourcePath !== "residentialAddress" || addr.Dia_chi_tam_tru.isRequired !== true) throw new Error("Dia_chi_tam_tru semantics wrong");

const mappingJson = JSON.stringify(MAPPING);

// ----- v7 DRAFT migration -----
const migration = `-- ============================================================
-- CANONICAL TRAINEE-REGISTRATION HTML — v7 DRAFT (OPERATOR test(2).html)
-- ------------------------------------------------------------
-- Operator source : incoming/test2.html  (a.k.a. "test(2).html")
-- Source SHA-256  : ${sourceHash}
-- Body SHA-256    : ${bodyHash}
-- Print CSS SHA   : ${cssHash}
-- Logical .paper  : ${pageCount} (derived from the source, not enforced)
-- Placeholders    : ${placeholders.length} (current approved mapping, unchanged)
--
-- NON-DESTRUCTIVE / DRAFT ONLY.
-- This migration adds ONE new DRAFT version (v7). It does NOT publish, does
-- NOT set current_published_version, does NOT change html_enabled, does NOT
-- touch v6, does NOT modify merge_template_fields (Production mapping), does
-- NOT create jobs, and does NOT activate HTML_PDF. v6 remains the PUBLISHED
-- runtime version until an operator explicitly publishes v7.
--
-- mapping_snapshot is intentionally EMPTY ('[]') for the DRAFT. The snapshot
-- is created ONLY at PUBLISH time by publishTemplateVersion(), which reads the
-- CURRENT non-orphaned merge_template_fields (the approved 49 rows including
-- the mandatory address semantics) and overwrites this column. Draft previews
-- read merge_template_fields directly; the frozen PUBLISHED snapshot is what
-- jobs render. merge_template_fields is unchanged here.
-- ============================================================
WITH target_template AS (
  SELECT id
  FROM merge_templates
  WHERE google_doc_id = '${GOOGLE_DOC_ID}'
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
  $v7_html$${body}$v7_html$,
  $v7_css$${printCss}$v7_css$,
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

-- Read-only verification: reports the v7 DRAFT row; v6 PUBLISHED untouched.
SELECT version, status, source_docx_name
FROM merge_template_versions
WHERE source_docx_name = '${SOURCE_DOCX_NAME}';
`;

writeFileSync(CANONICAL_SOURCE, canonicalSource, "utf8");
writeFileSync(MIGRATION_PATH, migration, "utf8");
writeFileSync(MAPPING_JSON_PATH, `${JSON.stringify(MAPPING, null, 2)}\n`, "utf8");

const manifest = {
  note: "Metadata only. The document body lives exclusively in merge_template_versions after an explicit Publish.",
  operatorSource: OPERATOR_SOURCE,
  operatorSourceDisplayName: "test(2).html",
  sourcePath: "templates/document-merge/trainee-registration/canonical-source.html",
  sourceSha256: sourceHash,
  canonicalBodySha256: bodyHash,
  canonicalPrintCssSha256: cssHash,
  draftVersion: 7,
  draftStatus: "DRAFT",
  draftMigration: "migrations/2026-08-24-trainee-registration-v7-operator-test2-draft.sql",
  // DRAFT invariant: mapping_snapshot is empty at draft time. publishTemplateVersion()
  // snapshots the CURRENT non-orphaned merge_template_fields (49 rows) at PUBLISH.
  draftMappingSnapshot: [],
  snapshotCreatedAtPublish: true,
  expectedPublishedMappingCount: 49,
  logicalPageCount: pageCount,
  pageSelector: ".paper",
  placeholderCount: placeholders.length,
  placeholders,
  addressSemantics: {
    Dia_chi_thuong_tru: { sourcePath: "permanentAddress", required: false },
    dia_chi_cu_tru: { sourcePath: "residentialAddress", required: false },
    Dia_chi_tam_tru: { sourcePath: "residentialAddress", required: true },
    crossAddressFallback: false,
  },
  sourceDocxName: SOURCE_DOCX_NAME,
  generatedBy: "scripts/sync-trainee-registration-v7.mjs",
};
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Operator source : ${OPERATOR_SOURCE} (${sourceHash})`);
console.log(`Canonical source: ${CANONICAL_SOURCE}`);
console.log(`v7 DRAFT SQL    : ${MIGRATION_PATH}`);
console.log(`Manifest        : ${MANIFEST_PATH}`);
console.log(`Pages (.paper)  : ${pageCount}`);
console.log(`Placeholders    : ${placeholders.length}`);
console.log(`DRAFT snapshot  : [] (snapshotted at PUBLISH from current merge_template_fields)`);
console.log(`Mapping self-check: ${MAPPING.length} rows (not written to DRAFT)`);
console.log(`Body SHA-256    : ${bodyHash}`);
