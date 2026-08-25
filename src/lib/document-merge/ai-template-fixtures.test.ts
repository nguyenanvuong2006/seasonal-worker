import test from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_TEMPLATE_HTML, SAMPLE_TEMPLATE_CSS, SAMPLE_TEMPLATE_PLACEHOLDERS } from "./ai-template-fixtures.ts";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";
import { analyzeTemplateLayout } from "./ai-template-layout.ts";
import { analyzeTemplateSecurity } from "./ai-template-security.ts";
import { analyzeTemplate } from "./ai-template-analyze.ts";
import { buildTemplateManifest, buildAiExportFiles, buildAiExportZip } from "./ai-template-export.ts";
import { checkWellFormedness, tokenizeHtml } from "./html-scanner.ts";
import { parseCss } from "./css-scanner.ts";
import { toMappingSemantics, type MappingSemantics } from "./template-diff.ts";
import { DRAFT_PREVIEW_MAPPING_SOURCE } from "./draft-preview.ts";

function mappingFor(placeholder: string): MappingSemantics {
  return toMappingSemantics({ placeholder, sourceType: "CORE_FIELD", sourcePath: placeholder, isRequired: false, isOrphaned: false });
}

test("fixture: placeholder inventory matches the documented 12-placeholder list exactly", () => {
  const found = extractUniquePlaceholders(SAMPLE_TEMPLATE_HTML);
  assert.deepEqual(found, [...SAMPLE_TEMPLATE_PLACEHOLDERS].sort());
});

test("fixture: is well-formed HTML and valid CSS", () => {
  assert.deepEqual(checkWellFormedness(tokenizeHtml(SAMPLE_TEMPLATE_HTML)), []);
  assert.deepEqual(parseCss(SAMPLE_TEMPLATE_CSS).issues, []);
});

test("fixture: produces zero security errors/warnings (no unsafe constructs)", () => {
  const { errors, warnings } = analyzeTemplateSecurity(SAMPLE_TEMPLATE_HTML, SAMPLE_TEMPLATE_CSS);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("fixture: the deliberately risky Địa chỉ tạm trú cell triggers all three placeholder-gated layout warnings", () => {
  const warnings = analyzeTemplateLayout(SAMPLE_TEMPLATE_HTML, SAMPLE_TEMPLATE_CSS);
  const codes = warnings.map((w) => w.code);
  assert.ok(codes.includes("FIXED_HEIGHT_DYNAMIC_CONTENT"));
  assert.ok(codes.includes("OVERFLOW_HIDDEN_DYNAMIC_CONTENT"));
  assert.ok(codes.includes("NOWRAP_DYNAMIC_CONTENT"));
  const addrWarnings = warnings.filter((w) => w.placeholders?.includes("Dia_chi_tam_tru"));
  assert.ok(addrWarnings.length >= 3, "all three warnings must name Dia_chi_tam_tru");
});

test("fixture: Địa chỉ thường trú (no fixed sizing) does NOT trigger any layout warning", () => {
  const warnings = analyzeTemplateLayout(SAMPLE_TEMPLATE_HTML, SAMPLE_TEMPLATE_CSS);
  const flaggedForThuongTru = warnings.filter((w) => w.placeholders?.includes("Dia_chi_thuong_tru"));
  assert.deepEqual(flaggedForThuongTru, []);
});

test("fixture: photo box (fixed height, no placeholder) does NOT trigger a layout warning", () => {
  const warnings = analyzeTemplateLayout(SAMPLE_TEMPLATE_HTML, SAMPLE_TEMPLATE_CSS);
  assert.equal(warnings.some((w) => w.tagName === "div" && w.code === "FIXED_HEIGHT_DYNAMIC_CONTENT" && !w.placeholders?.length), false);
  // No warning at all should reference the photo box — it has no placeholder inside.
  for (const w of warnings) {
    assert.ok(!w.message.includes("Ảnh") , "photo box row text must never appear in a warning message");
  }
});

test("fixture: blank signature space (fixed height, no placeholder) does NOT trigger a layout warning", () => {
  const warnings = analyzeTemplateLayout(SAMPLE_TEMPLATE_HTML, SAMPLE_TEMPLATE_CSS);
  const signatureRelated = warnings.filter((w) => w.placeholders?.length === 0);
  assert.deepEqual(signatureRelated, []);
});

test("fixture: SCOPED .signature-block break-inside:avoid does NOT trigger the global-break warning", () => {
  const warnings = analyzeTemplateLayout(SAMPLE_TEMPLATE_HTML, SAMPLE_TEMPLATE_CSS);
  assert.equal(warnings.some((w) => w.code === "GLOBAL_BREAK_INSIDE_AVOID"), false);
});

test("fixture: exactly the expected number of layout warnings — no more, no less (regression pin)", () => {
  const warnings = analyzeTemplateLayout(SAMPLE_TEMPLATE_HTML, SAMPLE_TEMPLATE_CSS);
  assert.equal(warnings.length, 3, `expected exactly 3 warnings (height/overflow/nowrap on Dia_chi_tam_tru), got: ${JSON.stringify(warnings.map((w) => w.code))}`);
});

test("fixture: full analyze pipeline against itself as base -> zero placeholder/mapping drift", () => {
  const mappings = SAMPLE_TEMPLATE_PLACEHOLDERS.map((p) => mappingFor(p));
  const result = analyzeTemplate({
    html: SAMPLE_TEMPLATE_HTML,
    printCss: SAMPLE_TEMPLATE_CSS,
    baseHtml: SAMPLE_TEMPLATE_HTML,
    baseMappings: mappings,
    currentMappings: mappings,
  });
  assert.equal(result.placeholders.total, 12);
  assert.equal(result.placeholders.unchanged, 12);
  assert.equal(result.placeholders.added, 0);
  assert.equal(result.placeholders.removed, 0);
  assert.equal(result.mappingsAffected, 0);
  assert.equal(result.htmlValid, true);
  assert.equal(result.cssValid, true);
  assert.equal(result.security.errors.length, 0);
  assert.equal(result.layoutWarnings.length, 3);
});

test("fixture: full AI export package builds successfully and stays PII/secret-free", async () => {
  const mappings = SAMPLE_TEMPLATE_PLACEHOLDERS.map((p) => mappingFor(p));
  const manifest = buildTemplateManifest({
    templateId: "tpl-fixture",
    templateName: "Đăng ký tập nghề (fixture)",
    documentKind: "B",
    version: 1,
    status: "PUBLISHED",
    htmlBody: SAMPLE_TEMPLATE_HTML,
    mappings,
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });
  assert.equal(manifest.placeholderCount, 12);

  const files = buildAiExportFiles(manifest, SAMPLE_TEMPLATE_HTML, SAMPLE_TEMPLATE_CSS);
  const zip = await buildAiExportZip(files);
  assert.ok(zip.length > 0);

  const combined = files.map((f) => f.content).join("\n");
  assert.doesNotMatch(combined, /\b\d{12}\b/);
  assert.doesNotMatch(combined, /DATABASE_URL/i);
});
