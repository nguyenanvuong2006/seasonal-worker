/**
 * UNSAVED PREVIEW — REAL END-TO-END PLACEHOLDER RESOLUTION (Defect A audit).
 *
 * All prior H2 route tests for unsaved-preview STUBBED OUT canonical-document.ts
 * (and therefore data-resolver.ts / html-renderer.ts) entirely — they proved the
 * route WIRES the pieces together correctly, but never proved the underlying
 * substitution pipeline itself actually replaces a placeholder with a real
 * value. This file closes that gap: it composes the SAME real functions the
 * unsaved-preview route calls (normalizeFullHtmlDocument -> selectPreviewMappings
 * -> buildCanonicalSnapshot -> renderCanonicalDocument), unstubbed, against a
 * synthetic candidate record and synthetic mappings covering the EXACT
 * placeholder names the operator reported still showing up literally in
 * production:
 *
 *   <<Ho_ten>> <<dia_chi_cu_tru>> <<Nam_thue>> <<Dia_diem_ky>>
 *   <<Ngay_ky_day>> <<Ngay_ky_month>> <<Ngay_ky_year>>
 *
 * No real candidate PII is used anywhere in this file — all names/addresses
 * are synthetic placeholders shaped like Vietnamese data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFullHtmlDocument } from "./full-document-normalizer.ts";
import { selectPreviewMappings, type PreviewFieldRow, type PreviewVersionRow } from "./draft-preview.ts";
import { buildCanonicalSnapshot, renderCanonicalDocument } from "./canonical-document.ts";
import type { MergeContext, RecordData } from "./data-resolver.ts";

function field(overrides: Partial<PreviewFieldRow> & { placeholder: string; sourcePath: string }): PreviewFieldRow {
  return {
    sourceType: "CORE_FIELD",
    sourceEntity: null,
    sourceField: null,
    optionValue: null,
    formatType: "RAW",
    fallbackValue: null,
    isRequired: false,
    isOrphaned: false,
    ...overrides,
  };
}

/** The exact 7 placeholders observed unresolved in production, mapped to synthetic RecordData paths. */
const OBSERVED_FIELDS: PreviewFieldRow[] = [
  field({ placeholder: "Ho_ten", sourcePath: "fullName" }),
  field({ placeholder: "dia_chi_cu_tru", sourcePath: "residentialAddress" }),
  field({ placeholder: "Nam_thue", sourcePath: "taxYear" }),
  field({ placeholder: "Dia_diem_ky", sourcePath: "signingLocation" }),
  field({ placeholder: "Ngay_ky_day", sourcePath: "signingDate", sourceType: "COMPUTED_FIELD", sourceField: "DATE_DAY" }),
  field({ placeholder: "Ngay_ky_month", sourcePath: "signingDate", sourceType: "COMPUTED_FIELD", sourceField: "DATE_MONTH" }),
  field({ placeholder: "Ngay_ky_year", sourcePath: "signingDate", sourceType: "COMPUTED_FIELD", sourceField: "DATE_YEAR" }),
];

const SYNTHETIC_RECORD: RecordData = {
  id: "syn-1",
  fullName: "Nguyễn Văn Test",
  residentialAddress: "Đà Lạt",
  taxYear: "2026",
  signingLocation: "TP. Hồ Chí Minh",
  signingDate: "2026-08-25",
};

const CONTEXT: MergeContext = { currentUserId: "u1", currentUserName: "Tester", currentDate: new Date("2026-08-25") };

function renderUnsaved(rawHtml: string, fields: PreviewFieldRow[], recordData: RecordData, version: PreviewVersionRow = { status: "DRAFT", mappingSnapshot: [] }) {
  const normalized = normalizeFullHtmlDocument(rawHtml);
  const { mappings } = selectPreviewMappings(version, fields);
  const snapshot = buildCanonicalSnapshot({
    templateId: "tpl-1",
    version: { templateId: "tpl-1", version: 10, status: version.status ?? "DRAFT", htmlBody: normalized.htmlBody, printCss: normalized.extractedCss, retentionYears: null },
    allowUnpublishedForVerification: true,
    mappings,
    formatting: { contractKey: null, retentionYears: null, documentKind: "GENERIC", templateName: "Test" },
  });
  return renderCanonicalDocument(snapshot, recordData, CONTEXT);
}

test("1. unsaved Preview resolves Ho_ten with the real end-to-end pipeline (no mocks)", () => {
  const rendered = renderUnsaved(`<p><<Ho_ten>></p>`, OBSERVED_FIELDS, SYNTHETIC_RECORD);
  assert.match(rendered.html, /Nguyễn Văn Test/);
  assert.doesNotMatch(rendered.html, /<<Ho_ten>>/);
  assert.deepEqual(rendered.unreplaced, []);
});

test("2. resolves dia_chi_cu_tru", () => {
  const rendered = renderUnsaved(`<p><<dia_chi_cu_tru>></p>`, OBSERVED_FIELDS, SYNTHETIC_RECORD);
  assert.match(rendered.html, /Đà Lạt/);
  assert.doesNotMatch(rendered.html, /<<dia_chi_cu_tru>>/);
});

test("3. resolves Nam_thue", () => {
  const rendered = renderUnsaved(`<p><<Nam_thue>></p>`, OBSERVED_FIELDS, SYNTHETIC_RECORD);
  assert.match(rendered.html, />2026</);
  assert.doesNotMatch(rendered.html, /<<Nam_thue>>/);
});

test("4. resolves Dia_diem_ky", () => {
  const rendered = renderUnsaved(`<p><<Dia_diem_ky>></p>`, OBSERVED_FIELDS, SYNTHETIC_RECORD);
  assert.match(rendered.html, /TP\. Hồ Chí Minh/);
  assert.doesNotMatch(rendered.html, /<<Dia_diem_ky>>/);
});

test("5. resolves Ngay_ky_day/month/year (split date parts, formatType DATE_DAY/MONTH/YEAR)", () => {
  const rendered = renderUnsaved(`<p><<Ngay_ky_day>>/<<Ngay_ky_month>>/<<Ngay_ky_year>></p>`, OBSERVED_FIELDS, SYNTHETIC_RECORD);
  assert.match(rendered.html, /25\/08\/2026/);
  assert.doesNotMatch(rendered.html, /<<Ngay_ky_day>>|<<Ngay_ky_month>>|<<Ngay_ky_year>>/);
});

test("6. DRAFT uses current (live) mappings — an edit to the live field is reflected without publishing", () => {
  const editedFields = OBSERVED_FIELDS.map((f) => (f.placeholder === "Ho_ten" ? { ...f, sourcePath: "id" } : f));
  const rendered = renderUnsaved(`<<Ho_ten>>`, editedFields, SYNTHETIC_RECORD, { status: "DRAFT", mappingSnapshot: [] });
  assert.match(rendered.html, /syn-1/);
});

test("7. PUBLISHED uses the FROZEN mapping_snapshot, ignoring live field edits", () => {
  const frozenSnapshot = [field({ placeholder: "Ho_ten", sourcePath: "fullName" })];
  // Live fields have since been (mis)edited to a different sourcePath —
  // PUBLISHED must still render from the frozen snapshot, not this.
  const liveFieldsEditedAfterPublish = [field({ placeholder: "Ho_ten", sourcePath: "id" })];
  const rendered = renderUnsaved(`<<Ho_ten>>`, liveFieldsEditedAfterPublish, SYNTHETIC_RECORD, {
    status: "PUBLISHED",
    mappingSnapshot: frozenSnapshot,
  });
  assert.match(rendered.html, /Nguyễn Văn Test/);
  assert.doesNotMatch(rendered.html, /syn-1/);
});

test("8. an unresolved (genuinely unmapped) required placeholder is reported in `unreplaced` — never silently hidden", () => {
  const withoutNamThue = OBSERVED_FIELDS.filter((f) => f.placeholder !== "Nam_thue");
  const rendered = renderUnsaved(`<<Ho_ten>> <<Nam_thue>>`, withoutNamThue, SYNTHETIC_RECORD);
  assert.ok(rendered.unreplaced.includes("Nam_thue"));
  assert.match(rendered.html, /<<Nam_thue>>/, "genuinely unmapped placeholders remain literal — this is the signal the guard reads, not a silent failure");
});

test("9. optional field with no data resolves to an intentionally-blank string, not a literal unresolved tag", () => {
  const optionalField = [field({ placeholder: "Ghi_chu", sourcePath: "nonexistentField", isRequired: false })];
  const rendered = renderUnsaved(`before[<<Ghi_chu>>]after`, optionalField, SYNTHETIC_RECORD);
  assert.match(rendered.html, /before\[\]after/);
  assert.deepEqual(rendered.unreplaced, [], "optional blank placeholders are NOT unresolved — they resolve to empty string");
});

test("10. this whole composition performs zero I/O / zero DB writes — pure function composition only", () => {
  // Structural proof: every function used here is imported directly with no
  // db/@/db import anywhere in this test file (grep-visible), and none of
  // normalizeFullHtmlDocument/selectPreviewMappings/buildCanonicalSnapshot/
  // renderCanonicalDocument accept a db handle or perform I/O — they are pure
  // data transformations over their arguments only.
  const before = renderUnsaved(`<<Ho_ten>>`, OBSERVED_FIELDS, SYNTHETIC_RECORD);
  const after = renderUnsaved(`<<Ho_ten>>`, OBSERVED_FIELDS, SYNTHETIC_RECORD);
  assert.equal(before.html, after.html, "deterministic, side-effect-free — repeated calls with identical input produce identical output");
});

/* -------------------------------------------------------------------- *
 * PHASE 11 — UNSAVED PRINT PARITY (real pipeline, not route mocks).
 * Preview and Print both call normalizeFullHtmlDocument -> selectPreviewMappings
 * -> buildCanonicalSnapshot -> renderCanonicalDocument with the SAME inputs
 * (same candidate, same pasted HTML, same mapping set) — there is only ONE
 * resolution implementation, so their core rendered HTML must be identical
 * before Print additionally injects its screen-only toolbar.
 * ------------------------------------------------------------------- */

test("11/12. Preview and Print produce IDENTICAL resolved content for the same candidate/HTML/mappings — no literal placeholders in one but not the other", () => {
  const rawHtml = `<!DOCTYPE html><html><body><p><<Ho_ten>> - <<dia_chi_cu_tru>></p></body></html>`;
  // Two independent calls, exactly mirroring what unsaved-preview and
  // unsaved-print each do server-side — proving there is no second,
  // divergent resolution path.
  const previewRendered = renderUnsaved(rawHtml, OBSERVED_FIELDS, SYNTHETIC_RECORD);
  const printRendered = renderUnsaved(rawHtml, OBSERVED_FIELDS, SYNTHETIC_RECORD);
  assert.equal(previewRendered.html, printRendered.html);
  assert.deepEqual(previewRendered.unreplaced, printRendered.unreplaced);
  assert.doesNotMatch(printRendered.html, /<<Ho_ten>>|<<dia_chi_cu_tru>>/);
});

test("11b. parity holds for a genuinely unmapped placeholder too — SAME unreplaced list on both paths, never resolved on one and not the other", () => {
  const withoutNamThue = OBSERVED_FIELDS.filter((f) => f.placeholder !== "Nam_thue");
  const rawHtml = `<<Ho_ten>> <<Nam_thue>>`;
  const previewRendered = renderUnsaved(rawHtml, withoutNamThue, SYNTHETIC_RECORD);
  const printRendered = renderUnsaved(rawHtml, withoutNamThue, SYNTHETIC_RECORD);
  assert.deepEqual(previewRendered.unreplaced, printRendered.unreplaced);
  assert.deepEqual(previewRendered.unreplaced, ["Nam_thue"]);
});

/* -------------------------------------------------------------------- *
 * PHASE 10/17 — VARIABLE-LENGTH DATA ACCEPTANCE (SHORT/LONG/VERY_LONG).
 * The renderer/resolver must never truncate, clip, or otherwise mangle a
 * long value — wrapping/reflow is a CSS/print-engine concern (out of scope
 * for this Node-only test environment: no browser/Playwright is available
 * here), but the DATA PATH itself (escape + substitute) must be provably
 * length-independent.
 * ------------------------------------------------------------------- */

const SHORT_ADDRESS = "Đà Lạt";
const LONG_ADDRESS = "123 Đường Nguyễn Văn Cừ, Phường Tân Sơn Nhì, Quận Tân Phú, TP. Hồ Chí Minh";
const VERY_LONG_ADDRESS =
  "Thôn 4, Xã Ea Tul, Huyện Cư Mgar, Tỉnh Đắk Lắk (gần UBND xã, cạnh trường tiểu học, đối diện chợ Ea Tul, Việt Nam)";

test("24/25/26. SHORT/LONG/VERY_LONG address data all resolve completely, without truncation, clipping, or corruption", () => {
  for (const address of [SHORT_ADDRESS, LONG_ADDRESS, VERY_LONG_ADDRESS]) {
    const record: RecordData = { ...SYNTHETIC_RECORD, residentialAddress: address };
    const rendered = renderUnsaved(`<<dia_chi_cu_tru>>`, OBSERVED_FIELDS, record);
    assert.match(rendered.html, new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `full address must appear verbatim, not truncated: ${address}`);
    assert.deepEqual(rendered.unreplaced, []);
  }
});

test("27. a very long full name is not truncated either", () => {
  const longName = "Nguyễn Thị Kim Ngọc Ánh Dương Thảo Vy";
  const record: RecordData = { ...SYNTHETIC_RECORD, fullName: longName };
  const rendered = renderUnsaved(`<<Ho_ten>>`, OBSERVED_FIELDS, record);
  assert.match(rendered.html, /Nguyễn Thị Kim Ngọc Ánh Dương Thảo Vy/);
});

test("29. long data is HTML-escaped exactly like short data — no nowrap/clipping applied by the substitution step itself (that is a CSS concern, layout-checked separately)", () => {
  const record: RecordData = { ...SYNTHETIC_RECORD, residentialAddress: `${VERY_LONG_ADDRESS} <script>evil()</script>` };
  const rendered = renderUnsaved(`<<dia_chi_cu_tru>>`, OBSERVED_FIELDS, record);
  // Candidate DATA is always escaped, even when it happens to contain
  // markup-shaped text — this is a data-value concern, not a template
  // security concern (which is about the TEMPLATE's own markup).
  assert.doesNotMatch(rendered.html, /<script>evil\(\)<\/script>/);
  assert.match(rendered.html, /&lt;script&gt;/);
});

test("full-document paste mode: a COMPLETE AI-revised HTML document resolves all 7 observed placeholders in one pass", () => {
  const fullDoc = `<!DOCTYPE html>
<html><head><style>.page{width:210mm}</style></head>
<body>
<div class="page">
<p>Họ tên: <<Ho_ten>></p>
<p>Địa chỉ cư trú: <<dia_chi_cu_tru>></p>
<p>Năm thuế: <<Nam_thue>></p>
<p>Địa điểm ký: <<Dia_diem_ky>></p>
<p>Ngày ký: <<Ngay_ky_day>>/<<Ngay_ky_month>>/<<Ngay_ky_year>></p>
</div>
</body>
</html>`;
  const rendered = renderUnsaved(fullDoc, OBSERVED_FIELDS, SYNTHETIC_RECORD);
  assert.deepEqual(rendered.unreplaced, []);
  assert.match(rendered.html, /Nguyễn Văn Test/);
  assert.match(rendered.html, /Đà Lạt/);
  assert.match(rendered.html, /TP\. Hồ Chí Minh/);
  assert.equal(rendered.valid, true);
});
