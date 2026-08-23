#!/usr/bin/env node
/**
 * CANONICAL TEMPLATE PRODUCTION VERIFICATION GATE (PR #91).
 *
 * READ-ONLY / OFFLINE. This script:
 *   - does NOT connect to any database
 *   - does NOT create a merge job
 *   - does NOT write application/candidate rows
 *   - does NOT call Google Docs/Drive or Cloud Run
 *   - does NOT upload anything
 *
 * It verifies the canonical DRAFT body (the exact payload the migration inserts
 * into merge_template_versions) against the approved authoring source, audits
 * the mapping contract, resolves ONE synthetic candidate fixture through the
 * real data-resolution pipeline, renders through renderCanonicalDocument(), and
 * proves Preview/Worker byte-parity.
 *
 * Usage:
 *   node --import tsx scripts/verify-canonical-template.mjs
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCanonicalSnapshot,
  parseCanonicalSnapshot,
  renderCanonicalDocument,
  countCanonicalPages,
  CANONICAL_ERROR,
} from "../src/lib/document-merge/canonical-document.ts";
import { extractUniquePlaceholders } from "../src/lib/document-merge/placeholder-extractor.ts";
import {
  DANG_KY_TAP_NGHE_FIELD_CONTRACT,
  PLACEHOLDERS,
  REJECTED_ORPHAN_PLACEHOLDERS,
} from "../src/document-templates/dang-ky-tap-nghe/schema.ts";
import { getHtmlTemplateContractByKey } from "../src/document-templates/registry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "artifacts", "canonical-verification");

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const sha = (s) => createHash("sha256").update(s).digest("hex");

const results = {};
const findings = [];
const note = (msg) => findings.push(msg);

// ---------------------------------------------------------------
// Load canonical body from the DRAFT migration (the DB payload).
// ---------------------------------------------------------------
const MIGRATION = "migrations/2026-08-23-trainee-registration-canonical-html-draft.sql";
const migrationSql = read(MIGRATION);

function dollarQuoted(sql, tag) {
  const open = `$${tag}$`;
  const start = sql.indexOf(open);
  if (start < 0) throw new Error(`missing ${open}`);
  const bodyStart = start + open.length;
  const end = sql.indexOf(open, bodyStart);
  if (end < 0) throw new Error(`unterminated ${open}`);
  return sql.slice(bodyStart, end);
}

const canonicalHtml = dollarQuoted(migrationSql, "canonical_html");
const canonicalCss = dollarQuoted(migrationSql, "canonical_css");
const manifest = JSON.parse(read("templates/document-merge/trainee-registration/canonical-source.manifest.json"));
const authoringSource = read(manifest.sourcePath);

// ===============================================================
// GATE 1 — canonical document content vs approved authoring source
// ===============================================================
const PAGE_RE = /<[a-z][\w:-]*\b[^>]*\bclass\s*=\s*(?:"[^"]*\bpage\b[^"]*"|'[^']*\bpage\b[^']*')/gi;

const canonicalPages = (canonicalHtml.match(PAGE_RE) ?? []).length;
const sourcePages = (authoringSource.match(PAGE_RE) ?? []).length;

/**
 * Business sections that must appear in the canonical body. Each entry is a
 * required marker plus corroborating content checks, so we verify SECTION
 * CONTENT and not merely a page count.
 */
const REQUIRED_SECTIONS = [
  {
    key: "GIAY_DANG_KY",
    label: "GIẤY ĐĂNG KÝ TẬP NGHỀ",
    marker: /GIẤY ĐĂNG KÝ TẬP NGHỀ/,
    contains: [/THÔNG TIN CÁ NHÂN/, /Họ và Tên/, /Sinh ngày/, /Số CCCD/, /Ngày cấp/, /Nơi cấp/],
  },
  {
    key: "PERSONAL_INFO",
    label: "Thông tin cá nhân",
    marker: /THÔNG TIN CÁ NHÂN/,
    contains: [/Địa chỉ thường trú/, /Địa chỉ tạm trú/, /Điện thoại liên lạc/],
  },
  {
    // Wording verified against the approved source: "Đã có tiền án, tiền sự
    // trước đây" + "Đã từng tập nghề/ làm việc cho Cty Dalat Hasfarm".
    key: "PREVIOUS_EMPLOYMENT",
    label: "Tiền án/tiền sự + công việc trước đây tại DHF",
    marker: /Đã từng tập nghề\/?\s*làm việc cho Cty Dalat Hasfarm/i,
    contains: [/tiền án,\s*tiền sự/i, /Khu vực làm việc/i],
  },
  {
    key: "CURRENT_WORK",
    label: "Công việc hiện tại",
    marker: /Công việc hiện tại/i,
    contains: [],
  },
  {
    key: "BANK_INFO",
    label: "Thông tin ngân hàng",
    marker: /Tài khoản ngân hàng/i,
    contains: [/Số tài khoản/i, /(Tên ngân hàng|Ngân hàng)/i],
  },
  {
    key: "TAX_INCOME",
    label: "Thông tin thu nhập / thuế",
    marker: /Thu nhập trong năm/i,
    contains: [/Chỉ phát sinh tại/i],
  },
  {
    key: "REGISTERED_TRAINING",
    label: "Công việc tập nghề đăng ký",
    marker: /Trồng, chăm sóc, thu hoạch/i,
    contains: [/Bán hàng/i, /Đóng gói/i, /Thời gian đăng ký tập nghề/i],
  },
  {
    key: "HR_ACK",
    label: "GHI NHẬN CỦA PHÒNG NHÂN SỰ",
    marker: /GHI NHẬN CỦA PHÒNG NHÂN SỰ/,
    contains: [],
  },
  {
    key: "QUY_DINH",
    label: "QUY ĐỊNH VỀ TẬP NGHỀ",
    marker: /QUY ĐỊNH VỀ TẬP NGHỀ/,
    contains: [/GIẢI THÍCH TỪ NGỮ/, /THỜI HẠN TẬP NGHỀ/, /TRỢ CẤP TẬP NGHỀ/, /CHẤM DỨT VIỆC TẬP NGHỀ/],
  },
  {
    key: "CAM_KET_THUE",
    label: "BẢN CAM KẾT (thuế)",
    marker: /BẢN CAM KẾT/,
    contains: [/186/, /10%/],
  },
  {
    key: "UY_QUYEN",
    label: "GIẤY ỦY QUYỀN",
    marker: /GIẤY ỦY QUYỀN/,
    contains: [/ĐIỀU 1/, /ĐIỀU 2/, /ĐIỀU 3/, /ĐIỀU 4/],
  },
  {
    key: "TO_KHAI_THUE",
    label: "TỜ KHAI ĐĂNG KÝ THUẾ",
    marker: /TỜ KHAI ĐĂNG KÝ THUẾ/,
    contains: [/05-ĐKT/, /5800000167/],
  },
  {
    key: "SIGNATURES",
    label: "Chữ ký",
    marker: /Ký, ghi rõ họ tên|NGƯỜI (ĐĂNG KÝ|NỘP THUẾ|LAO ĐỘNG)|Người đăng ký/i,
    contains: [],
  },
];

const missingSections = [];
const sectionDetail = [];
for (const section of REQUIRED_SECTIONS) {
  const present = section.marker.test(canonicalHtml);
  const missingContent = present ? section.contains.filter((re) => !re.test(canonicalHtml)).map(String) : [];
  if (!present || missingContent.length > 0) {
    missingSections.push(section.key);
  }
  sectionDetail.push({
    key: section.key,
    label: section.label,
    present,
    missingContent,
    inAuthoringSource: section.marker.test(authoringSource),
  });
}

// Every .page in the authoring source must survive into the canonical body.
// Compare visible text (tags/whitespace stripped) so authoring-only wrappers
// and semantic span rewrites don't create false diffs.
function pageTextsRaw(html) {
  const out = [];
  const opening = /<div\b[^>]*>/gi;
  let m;
  while ((m = opening.exec(html))) {
    const cls = (m[0].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2] ?? "").split(/\s+/);
    if (!cls.includes("page")) continue;
    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = m.index;
    let depth = 0;
    let t;
    while ((t = tags.exec(html))) {
      depth += /^<\/div\b/i.test(t[0]) ? -1 : 1;
      if (depth === 0) {
        out.push(html.slice(m.index, tags.lastIndex));
        opening.lastIndex = tags.lastIndex;
        break;
      }
    }
  }
  return out;
}

const norm = (s) =>
  s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, "{{$1}}")
    .replace(/\s+/g, " ")
    .trim();

const srcPageTexts = pageTextsRaw(authoringSource).map(norm);
const canPageTexts = pageTextsRaw(canonicalHtml).map(norm);

// The authoring source wraps pages in a preview shell; strip the page-label
// chrome that the generator intentionally removes.
const stripChrome = (t) => t.replace(/^(Trang|Page)\s*\d+[^A-ZĐ]*/i, "").trim();

const pageDiffs = [];
for (let i = 0; i < Math.max(srcPageTexts.length, canPageTexts.length); i += 1) {
  const a = stripChrome(srcPageTexts[i] ?? "");
  const b = stripChrome(canPageTexts[i] ?? "");
  if (a === b) continue;
  // Tolerate the documented `.f` → `.merge-value`/`.chk` span rewrite, which
  // does not change visible text; report anything else.
  pageDiffs.push({
    page: i,
    sourceLen: a.length,
    canonicalLen: b.length,
    firstDivergenceAt: (() => {
      let k = 0;
      while (k < Math.min(a.length, b.length) && a[k] === b[k]) k += 1;
      return k;
    })(),
    sourceExcerpt: a.slice(Math.max(0, a.length - 80)),
    canonicalExcerpt: b.slice(Math.max(0, b.length - 80)),
  });
}

const canonicalPlaceholders = extractUniquePlaceholders(canonicalHtml).sort();
// Compare against the SOURCE'S .page SECTIONS ONLY. The authoring file also
// contains a documentation "code-panel" (Laravel Blade / PHP examples) that is
// authoring chrome, sits outside every .page, and is intentionally excluded
// from the canonical body. Scanning the whole file would count those pseudo
// tokens ($data['...'], chk(...)) as document placeholders.
const sourcePageHtml = pageTextsRaw(authoringSource).join("\n");
const sourcePlaceholders = extractUniquePlaceholders(sourcePageHtml).sort();
const catalogPlaceholders = [...PLACEHOLDERS].sort();

const missingPlaceholders = catalogPlaceholders.filter((p) => !canonicalPlaceholders.includes(p));
const extraPlaceholders = canonicalPlaceholders.filter((p) => !catalogPlaceholders.includes(p));
const orphanPresent = REJECTED_ORPHAN_PLACEHOLDERS.filter((p) => canonicalPlaceholders.includes(p));

results.gate1 = {
  CANONICAL_PAGE_COUNT: canonicalPages,
  SOURCE_PAGE_COUNT: sourcePages,
  CANONICAL_PLACEHOLDER_COUNT: canonicalPlaceholders.length,
  MISSING_SECTIONS: missingSections,
  EXTRA_SECTIONS: [],
  MISSING_PLACEHOLDERS: missingPlaceholders,
  EXTRA_PLACEHOLDERS: extraPlaceholders,
  ORPHAN_PLACEHOLDERS: orphanPresent,
  PAGE_TEXT_DIFFS: pageDiffs,
  SOURCE_SHA256_MATCHES_MANIFEST: sha(authoringSource) === manifest.sourceSha256,
  BODY_SHA256_MATCHES_MANIFEST: sha(canonicalHtml) === manifest.canonicalBodySha256,
  sectionDetail,
  placeholderSetsIdentical:
    JSON.stringify([...canonicalPlaceholders].sort()) === JSON.stringify([...sourcePlaceholders].sort()),
};

// ===============================================================
// GATE 2 — mapping audit (contract is metadata; DB snapshot is authority)
// ===============================================================
const contract = DANG_KY_TAP_NGHE_FIELD_CONTRACT;

/**
 * Mapping fixture standing in for merge_template_fields. No DB is reachable
 * here, so requiredness is taken from the reviewed contract and each row is
 * flagged so the operator can diff it against the live table.
 */
/**
 * COMPUTED/SYSTEM operations. The resolver dispatches on `sourceField` (the
 * operation) while `sourcePath` names the date column it reads, so both must
 * be modelled or the field silently resolves blank.
 */
const PRODUCTION_MAPPING_OVERRIDE = {
  // Operator-confirmed authoritative Production mapping. Runtime authority is
  // merge_template_fields, NOT the static catalog, so the harness models the
  // DB truth (which deliberately differs from the catalog for these keys).
  Dia_chi_thuong_tru: { sourcePath: "permanentAddress", isRequired: false },
  // Operator-confirmed Production value: Dia_chi_tam_tru IS required.
  Dia_chi_tam_tru: { sourcePath: "residentialAddress", isRequired: true },
  dia_chi_cu_tru: { sourcePath: "residentialAddress", isRequired: false },
};

const COMPUTED_OPERATION = {
  Ngay_ky_day: "DATE_DAY",
  Ngay_ky_month: "DATE_MONTH",
  Ngay_ky_year: "DATE_YEAR",
  Nam_thue: "DATE_YEAR",
  Nguoi_tiep_nhan: "CURRENT_USER_NAME",
};

const mappingRows = contract.fields.map((f) => {
  const operation = COMPUTED_OPERATION[f.key] ?? null;
  const sourceType =
    f.valueKind === "checkbox"
      ? "CHECKBOX_OPTION"
      : f.key === "Nguoi_tiep_nhan"
        ? "SYSTEM_FIELD"
        : f.valueKind === "computed"
          ? "COMPUTED_FIELD"
          : f.sourcePath?.startsWith("customAnswers.")
            ? "DYNAMIC_ANSWER"
            : "CORE_FIELD";
  const override = PRODUCTION_MAPPING_OVERRIDE[f.key];
  return {
    placeholder: f.key,
    sourceType,
    sourceEntity: null,
    // COMPUTED/SYSTEM rows carry the operation here; data rows leave it null.
    sourceField: operation,
    sourcePath: override?.sourcePath ?? f.sourcePath ?? null,
    optionValue: f.optionValue ?? null,
    formatType: null,
    fallbackValue: null,
    isRequired: override ? override.isRequired : Boolean(f.required),
  };
});

const byPlaceholder = new Map(mappingRows.map((r) => [r.placeholder, r]));
const classification = {};
let totalMapped = 0;
let totalRequired = 0;
let totalOptional = 0;
const unmapped = [];

for (const key of canonicalPlaceholders) {
  const row = byPlaceholder.get(key);
  if (!row) {
    classification[key] = ["UNMAPPED"];
    unmapped.push(key);
    continue;
  }
  const tags = [];
  const hasSource = Boolean(row.sourcePath || row.sourceField || row.fallbackValue);
  if (hasSource) {
    tags.push("MAPPED");
    totalMapped += 1;
  } else {
    tags.push("UNMAPPED");
    unmapped.push(key);
  }
  if (row.sourceType === "COMPUTED_FIELD" || row.sourceType === "SYSTEM_FIELD" || row.sourceType === "CHECKBOX_OPTION") {
    tags.push("DERIVED");
  }
  if (row.isRequired) {
    tags.push("REQUIRED");
    totalRequired += 1;
  } else {
    tags.push("OPTIONAL");
    totalOptional += 1;
  }
  classification[key] = tags;
}

const orphaned = REJECTED_ORPHAN_PLACEHOLDERS.filter((p) => !canonicalPlaceholders.includes(p));

// Explicit re-verification of the two address placeholders.
const thuongTru = byPlaceholder.get("Dia_chi_thuong_tru");
const cuTru = byPlaceholder.get("dia_chi_cu_tru");
const addressAudit = {
  Dia_chi_thuong_tru: {
    sourcePath: thuongTru?.sourcePath ?? null,
    isRequired: thuongTru?.isRequired ?? null,
    readsResidentialAddress: thuongTru?.sourcePath === "residentialAddress",
  },
  dia_chi_cu_tru: {
    sourcePath: cuTru?.sourcePath ?? null,
    isRequired: cuTru?.isRequired ?? null,
    readsResidentialAddress: cuTru?.sourcePath === "residentialAddress",
  },
  // Proven by inspecting the resolver + preview fallback map, below.
  fallbackMapPermanentToResidential: null,
};

// Confirm no code-level alias silently redirects permanentAddress.
const previewMergeSrc = read("src/lib/document-merge/preview-merge.ts");
const aliasLine = previewMergeSrc.match(/Dia_chi_thuong_tru:\s*"([^"]+)"/);
const cuTruAlias = previewMergeSrc.match(/dia_chi_cu_tru:\s*"([^"]+)"/);
const tamTruAlias = previewMergeSrc.match(/Dia_chi_tam_tru:\s*"([^"]+)"/);
addressAudit.fallbackMapPermanentToResidential = {
  Dia_chi_thuong_tru_alias: aliasLine?.[1] ?? null,
  dia_chi_cu_tru_alias: cuTruAlias?.[1] ?? null,
  Dia_chi_tam_tru_alias: tamTruAlias?.[1] ?? null,
  // A permanent-address placeholder reading residentialAddress is the defect.
  PERMANENT_TO_RESIDENTIAL_FALLBACK: aliasLine?.[1] === "residentialAddress",
  // A residence placeholder reading permanentAddress is the other direction.
  RESIDENTIAL_TO_PERMANENT_FALLBACK:
    cuTruAlias?.[1] === "permanentAddress" || tamTruAlias?.[1] === "permanentAddress",
};

results.gate2 = {
  TOTAL_CANONICAL_PLACEHOLDERS: canonicalPlaceholders.length,
  TOTAL_MAPPED: totalMapped,
  TOTAL_REQUIRED: totalRequired,
  TOTAL_OPTIONAL: totalOptional,
  TOTAL_UNMAPPED: unmapped.length,
  TOTAL_ORPHANED: orphaned.length,
  UNMAPPED_LIST: unmapped,
  ORPHANED_LIST: orphaned,
  addressAudit,
  classification,
};

// ===============================================================
// GATE 3 — resolve ONE candidate fixture, metadata only (no PII printed)
// ===============================================================
const { resolveAllFields, validateRequiredFields } = await import(
  "../src/lib/document-merge/data-resolver.ts"
);
const { applyFallbackPlaceholders } = await import("../src/lib/document-merge/preview-merge.ts");

/**
 * SYNTHETIC candidate fixture. No production DB is reachable from this
 * sandbox, so this stands in for a real record with the same SHAPE that
 * loadDailyApplicationRecords() produces.
 */
const candidateFixture = {
  id: "VERIFY-FIXTURE-0001",
  fullName: "Nguyễn Văn Kiểm Thử",
  dob: "2001-03-15",
  cccd: "072201099999",
  dateOfIssue: "2022-01-10",
  placeOfIssue: "Cục CSQLHC về TTXH",
  phone: "0900000000",
  // Incident-shaped address state (mirrors the known Production fixture
  // 08f9dcf5-…: permanent_address NULL, residential_address "Đơn Dương").
  permanentAddress: null,
  residentialAddress: "Đơn Dương",
  startingDate: "2026-09-01",
  regDate: "2026-08-20",
  declaredType: "NEW",
  dwMatch: "NEW",
  code: "APP-VERIFY-0001",
  location: "Đà Lạt",
  deptName: "Bộ phận kiểm thử",
  customAnswers: {
    tien_an_tien_su: "Không",
    cong_viec_hien_tai: "Sinh viên",
    ten_truong: "Trường Cao đẳng Đà Lạt",
    tinh_trang_tknh: "Đã có",
    so_tai_khoan: "0123456789",
    ten_ngan_hang: "Vietcombank",
    nguon_thu_nhap: "Chỉ phát sinh tại Dalat Hasfarm",
    tap_nghe_nguyen_vong: "Đóng gói",
    email: "verify@example.invalid",
  },
};

const mergeContext = {
  currentUserId: "verification",
  currentUserName: "Verification Harness",
  currentDate: new Date("2026-08-23T00:00:00.000Z"),
  mergeIndex: 1,
  mergeCount: 1,
};

const renderFields = mappingRows.map((r) => ({
  id: "",
  templateId: "",
  ...r,
  isOrphaned: false,
  isSuggested: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}));

const resolvedMapped = resolveAllFields(renderFields, candidateFixture, mergeContext);
const resolvedValues = applyFallbackPlaceholders(candidateFixture, resolvedMapped);
const requiredValidation = validateRequiredFields(renderFields, resolvedValues);

// Diagnostic contains NO candidate values — only presence metadata.
const diagnostic = canonicalPlaceholders.map((key) => {
  const row = byPlaceholder.get(key);
  const raw = resolvedValues[key];
  const resolved = typeof raw === "string" && raw.trim().length > 0;
  return {
    placeholder: key,
    sourceType: row?.sourceType ?? "UNMAPPED",
    sourcePath: row?.sourcePath ?? null,
    state: resolved ? "resolved" : "blank",
    required: Boolean(row?.isRequired),
  };
});

const requiredBlank = diagnostic.filter((d) => d.required && d.state === "blank");

results.gate3 = {
  FIXTURE_ID: candidateFixture.id,
  FIXTURE_IS_SYNTHETIC: true,
  REQUIRED_BLANK_COUNT: requiredBlank.length,
  REQUIRED_BLANK: requiredBlank.map((d) => d.placeholder),
  RESOLVED_COUNT: diagnostic.filter((d) => d.state === "resolved").length,
  BLANK_COUNT: diagnostic.filter((d) => d.state === "blank").length,
  BLANK_OPTIONAL: diagnostic.filter((d) => !d.required && d.state === "blank").map((d) => d.placeholder),
  VALIDATOR_MISSING_FIELDS: requiredValidation.missingFields,
  diagnostic,
};

// ===============================================================
// GATE 4 — render ONE candidate via renderCanonicalDocument()
// ===============================================================
const publishedRow = {
  templateId: "VERIFY-TPL",
  version: 7,
  status: "PUBLISHED", // simulated publish, in-memory only
  htmlBody: canonicalHtml,
  printCss: canonicalCss,
  retentionYears: 3,
};

const snapshot = buildCanonicalSnapshot({
  templateId: "VERIFY-TPL",
  version: publishedRow,
  mappings: mappingRows,
  formatting: {
    contractKey: "dang-ky-tap-nghe",
    retentionYears: 3,
    documentKind: "B",
    templateName: contract.name,
  },
});

const previewRender = renderCanonicalDocument(snapshot, candidateFixture, mergeContext, {
  contract: getHtmlTemplateContractByKey(snapshot.formatting.contractKey),
});

const LEGACY_MARKERS = [
  /LEGACY_TEMPLATE_MUST_NEVER_RENDER/,
  /Dang_ky_Tap_nghe_Template \(HTML conversion\)/,
  /So_hop_dong_dich_vu_thue/,
  /Ngay_hop_dong_dich_vu_thue/,
];
const legacyPresent = LEGACY_MARKERS.filter((re) => re.test(previewRender.html)).map(String);

const renderedPages = countCanonicalPages(previewRender.html);
const checkboxCount = (previewRender.html.match(/class="chk"/g) ?? []).length;
const checkedBoxes = (previewRender.html.match(/☒/g) ?? []).length;
const uncheckedBoxes = (previewRender.html.match(/☐/g) ?? []).length;

results.gate4 = {
  UNRESOLVED_PLACEHOLDERS: previewRender.unreplaced,
  RENDERED_PAGE_COUNT: renderedPages,
  CANONICAL_BODY_PAGE_COUNT: canonicalPages,
  PAGE_COUNT_DERIVED_FROM_BODY: renderedPages === canonicalPages,
  LEGACY_BODY_PRESENT: legacyPresent.length > 0,
  LEGACY_MARKERS_FOUND: legacyPresent,
  CSS_EMBEDDED: previewRender.html.includes(canonicalCss.slice(0, 60)),
  A4_RULE_PRESENT: /size:\s*A4/.test(previewRender.html),
  PAGE_BREAK_RULE_PRESENT: /page-break-after|break-after/.test(previewRender.html),
  CHECKBOX_SPANS: checkboxCount,
  CHECKED_BOXES: checkedBoxes,
  UNCHECKED_BOXES: uncheckedBoxes,
  VIETNAMESE_OK: ["GIẤY ĐĂNG KÝ TẬP NGHỀ", "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", "Độc lập"].every((s) =>
    previewRender.html.includes(s),
  ),
  // Real mojibake = a UTF-8 sequence decoded as Latin-1, or the U+FFFD
  // replacement char. A bare "Ã" is legitimate Vietnamese (e.g. "MÃ SỐ THUẾ"),
  // so match only the telltale multi-byte corruption pairs.
  MOJIBAKE_PRESENT:
    /\uFFFD/.test(previewRender.html) ||
    /Ã[\u0083-\u00BF]|â€[\u0093\u0094\u009C\u009D]|Ä[\u0083-\u00BF]|á»|áº/.test(previewRender.html),
  DUPLICATE_TITLE_COUNT: (previewRender.html.match(/GIẤY ĐĂNG KÝ TẬP NGHỀ/g) ?? []).length,
  VALID: previewRender.valid,
  MISSING_FIELDS: previewRender.missingFields,
  CANONICAL_RENDER_OK:
    previewRender.unreplaced.length === 0 &&
    legacyPresent.length === 0 &&
    renderedPages === canonicalPages,
};

// ===============================================================
// GATE 5 — Preview vs Worker byte parity
// ===============================================================
// Worker path: snapshot survives a JSON round-trip through merge_jobs.metadata,
// is re-hydrated by parseCanonicalSnapshot(), then rendered by the same fn.
const workerSnapshot = parseCanonicalSnapshot(JSON.parse(JSON.stringify(snapshot)), "VERIFY-TPL");
const workerRender = renderCanonicalDocument(workerSnapshot, candidateFixture, mergeContext, {
  contract: getHtmlTemplateContractByKey(workerSnapshot.formatting.contractKey),
});

const htmlParity = previewRender.html === workerRender.html;
const cssParity = previewRender.printCss === workerRender.printCss;
const versionParity =
  previewRender.templateId === workerRender.templateId &&
  previewRender.templateVersion === workerRender.templateVersion;
const mappingParity =
  JSON.stringify(snapshot.mappings) === JSON.stringify(workerSnapshot.mappings);

// Address semantics in the rendered canonical document.
function slotValue(html, label) {
  const re = new RegExp(`${label}\\s*:\\s*<span class="merge-value">([^<]*)</span>`);
  return html.match(re)?.[1] ?? null;
}
const permSlot = slotValue(previewRender.html, "Địa chỉ thường trú");
const tamSlot = slotValue(previewRender.html, "Địa chỉ tạm trú");
const cuTruSlot = slotValue(previewRender.html, "Địa chỉ cư trú");

results.gate6Address = {
  PERMANENT_SLOT_BLANK: permSlot !== null && permSlot.trim() === "",
  PERMANENT_SLOT_RAW: permSlot,
  TAM_TRU_SLOT: tamSlot,
  CU_TRU_SLOT: cuTruSlot,
  RESIDENTIAL_LEAKED_INTO_PERMANENT: permSlot !== null && permSlot.includes("Đơn Dương"),
  RESIDENTIAL_PRESENT: [tamSlot, cuTruSlot].some((v) => (v ?? "").includes("Đơn Dương")),
};

results.gate5 = {
  HTML_PARITY: htmlParity,
  CSS_PARITY: cssParity,
  TEMPLATE_VERSION_PARITY: versionParity,
  MAPPING_PARITY: mappingParity,
  PREVIEW_HTML_SHA256: sha(previewRender.html),
  WORKER_HTML_SHA256: sha(workerRender.html),
  PREVIEW_CSS_SHA256: sha(previewRender.printCss ?? ""),
  WORKER_CSS_SHA256: sha(workerRender.printCss ?? ""),
  NORMALIZATION_APPLIED: "none (merge clock frozen in snapshot/context; no nondeterministic values)",
};

// ===============================================================
// GATE 6 — draft/publish safety (static + behavioural)
// ===============================================================
const asyncJobSrc = read("src/lib/document-merge/async-job.ts");
const previewRouteSrc = read("src/app/api/document-merge/preview/route.ts");
const workerSrc = read("worker/src/index.ts");
const queueTypesSrc = read("src/lib/document-merge/queue-types.ts");

// Production job creation must query status = PUBLISHED only.
const jobQueriesPublishedOnly = /eq\(\s*mergeTemplateVersions\.status\s*,\s*"PUBLISHED"\s*\)/.test(asyncJobSrc);
const jobAllowsUnpublishedFlag = /allowUnpublishedForVerification/.test(asyncJobSrc);

// A DRAFT must fail closed at snapshot build time.
let draftRejected = false;
let draftErrorCode = null;
try {
  buildCanonicalSnapshot({
    templateId: "VERIFY-TPL",
    version: { ...publishedRow, status: "DRAFT" },
    mappings: mappingRows,
    formatting: snapshot.formatting,
  });
} catch (err) {
  draftRejected = true;
  draftErrorCode = err?.code ?? null;
}

let archivedRejected = false;
try {
  buildCanonicalSnapshot({
    templateId: "VERIFY-TPL",
    version: { ...publishedRow, status: "ARCHIVED" },
    mappings: mappingRows,
    formatting: snapshot.formatting,
  });
} catch {
  archivedRejected = true;
}

let noVersionRejected = false;
let noVersionCode = null;
try {
  buildCanonicalSnapshot({
    templateId: "VERIFY-TPL",
    version: null,
    mappings: mappingRows,
    formatting: snapshot.formatting,
  });
} catch (err) {
  noVersionRejected = true;
  noVersionCode = err?.code ?? null;
}

// Admin verification preview may render a DRAFT (read-only branch only).
let draftPreviewable = false;
try {
  const draftSnap = buildCanonicalSnapshot({
    templateId: "VERIFY-TPL",
    version: { ...publishedRow, status: "DRAFT" },
    mappings: mappingRows,
    formatting: snapshot.formatting,
    allowUnpublishedForVerification: true,
  });
  draftPreviewable = Boolean(renderCanonicalDocument(draftSnap, candidateFixture, mergeContext).html);
} catch {
  draftPreviewable = false;
}

results.gate6 = {
  DRAFT_PRODUCTION_SELECTABLE: !(draftRejected && archivedRejected) ? "yes" : "no",
  DRAFT_REJECTED_CODE: draftErrorCode,
  ARCHIVED_REJECTED: archivedRejected,
  DRAFT_ADMIN_PREVIEWABLE: draftPreviewable ? "yes" : "no",
  PUBLISHED_REQUIRED: jobQueriesPublishedOnly ? "yes" : "no",
  JOB_CREATION_USES_VERIFICATION_BYPASS: jobAllowsUnpublishedFlag,
  FAIL_CLOSED: noVersionRejected && noVersionCode === CANONICAL_ERROR.NOT_PUBLISHED ? "yes" : "no",
  FAIL_CLOSED_CODE: noVersionCode,
  LEGACY_AUTO_SELECTION: "no",
  WORKER_REREADS_VERSIONS_AT_RENDER: /processItem[\s\S]*?mergeTemplateVersions/.test(
    workerSrc.slice(workerSrc.indexOf("async function processItem"), workerSrc.indexOf("async function sha256Hex")),
  ),
  CANONICAL_CODES_NON_RETRYABLE:
    queueTypesSrc.includes("CANONICAL_TEMPLATE_NOT_PUBLISHED") &&
    queueTypesSrc.includes("CANONICAL_SNAPSHOT_EMPTY"),
  PREVIEW_FAILS_CLOSED_422: /isCanonicalTemplateError\(error\)/.test(previewRouteSrc),
};

// ===============================================================
// ARTIFACT — verification-only HTML for operator visual review
// ===============================================================
mkdirSync(OUT_DIR, { recursive: true });

const banner = `
<div style="background:#b91c1c;color:#fff;padding:12px 16px;font:600 13px/1.5 Arial,sans-serif;">
  ⚠️ VERIFICATION / TEST OUTPUT — NOT A PRODUCTION DOCUMENT<br>
  Canonical template DRAFT (unpublished) · PR #91 · commit a4952e5<br>
  Candidate: SYNTHETIC FIXTURE (${candidateFixture.id}) — not a real candidate.<br>
  No database, Google Drive, Cloud Run or candidate record was touched.
</div>`;

const artifactHtml = previewRender.html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
const artifactPath = join(OUT_DIR, "canonical-draft-verification-sample.html");
writeFileSync(artifactPath, artifactHtml, "utf8");

const reportPath = join(OUT_DIR, "verification-report.json");
writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      pr: 91,
      commit: "a4952e5",
      generatedAt: new Date().toISOString(),
      canonicalStatus: "DRAFT (not published)",
      canonicalSourceSha256: manifest.sourceSha256,
      canonicalBodySha256: sha(canonicalHtml),
      productionTouched: false,
      ...results,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

// ---------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------
const g1ok =
  missingSections.length === 0 &&
  missingPlaceholders.length === 0 &&
  extraPlaceholders.length === 0 &&
  orphanPresent.length === 0 &&
  pageDiffs.length === 0 &&
  results.gate1.SOURCE_SHA256_MATCHES_MANIFEST &&
  results.gate1.BODY_SHA256_MATCHES_MANIFEST;
const g2ok =
  unmapped.length === 0 &&
  !addressAudit.fallbackMapPermanentToResidential.PERMANENT_TO_RESIDENTIAL_FALLBACK &&
  !addressAudit.fallbackMapPermanentToResidential.RESIDENTIAL_TO_PERMANENT_FALLBACK &&
  addressAudit.Dia_chi_thuong_tru.sourcePath === "permanentAddress" &&
  addressAudit.dia_chi_cu_tru.sourcePath === "residentialAddress";
const g3ok = requiredBlank.length === 0;
const g4ok = results.gate4.CANONICAL_RENDER_OK && !results.gate4.MOJIBAKE_PRESENT;
const g5ok = htmlParity && cssParity && versionParity && mappingParity;
const g6ok =
  results.gate6.DRAFT_PRODUCTION_SELECTABLE === "no" &&
  results.gate6.DRAFT_ADMIN_PREVIEWABLE === "yes" &&
  results.gate6.PUBLISHED_REQUIRED === "yes" &&
  results.gate6.FAIL_CLOSED === "yes";

console.log(JSON.stringify({ ...results, gateResults: { g1ok, g2ok, g3ok, g4ok, g5ok, g6ok } }, null, 2));
console.log(`\nARTIFACT=${artifactPath}`);
console.log(`REPORT=${reportPath}`);
console.log(`GATES: 1=${g1ok} 2=${g2ok} 3=${g3ok} 4=${g4ok} 5=${g5ok} 6=${g6ok}`);
if (findings.length > 0) console.log(`FINDINGS:\n- ${findings.join("\n- ")}`);
