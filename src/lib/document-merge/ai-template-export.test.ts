import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTemplateManifest,
  buildReadmeAi,
  buildAiExportFiles,
  buildAiExportZip,
  AI_EXPORT_CONTRACT_VERSION,
} from "./ai-template-export.ts";
import { toMappingSemantics, type MappingSemantics } from "./template-diff.ts";
import { DRAFT_PREVIEW_MAPPING_SOURCE } from "./draft-preview.ts";

function mapping(overrides: Partial<MappingSemantics> = {}): MappingSemantics {
  return toMappingSemantics({
    placeholder: "Ho_ten",
    sourceType: "CORE_FIELD",
    sourceField: null,
    sourcePath: "fullName",
    optionValue: null,
    formatType: "RAW",
    fallbackValue: null,
    isRequired: true,
    isOrphaned: false,
    ...overrides,
  });
}

const SAMPLE_HTML = `<div class="page"><p><<Ho_ten>></p><p><<Dia_chi_thuong_tru>></p></div>`;

test("manifest: placeholder inventory matches HTML body, marks required/mapped correctly", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "Đăng ký tập nghề",
    documentKind: "B",
    version: 8,
    status: "PUBLISHED",
    htmlBody: SAMPLE_HTML,
    mappings: [mapping({ placeholder: "Ho_ten", isRequired: true }), mapping({ placeholder: "Dia_chi_thuong_tru", sourcePath: "permanentAddress", isRequired: false })],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });

  assert.equal(manifest.placeholderCount, 2);
  assert.equal(manifest.contractVersion, AI_EXPORT_CONTRACT_VERSION);
  const hoTen = manifest.placeholders.find((p) => p.key === "Ho_ten");
  assert.equal(hoTen?.required, true);
  assert.equal(hoTen?.mapped, true);
  const diaChi = manifest.placeholders.find((p) => p.key === "Dia_chi_thuong_tru");
  assert.equal(diaChi?.sourcePath, "permanentAddress");
  assert.equal(diaChi?.required, false);
});

test("manifest: PUBLISHED export documents mappingSource = frozen snapshot semantics", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "T",
    documentKind: "B",
    version: 3,
    status: "PUBLISHED",
    htmlBody: `<<A>>`,
    mappings: [mapping({ placeholder: "A" })],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });
  assert.equal(manifest.mappingSource, "PUBLISHED_MAPPING_SNAPSHOT");
});

test("manifest: DRAFT export documents mappingSource = current live fields semantics", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "T",
    documentKind: "B",
    version: 9,
    status: "DRAFT",
    htmlBody: `<<A>>`,
    mappings: [mapping({ placeholder: "A" })],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.CURRENT_FIELDS,
  });
  assert.equal(manifest.mappingSource, "CURRENT_MERGE_TEMPLATE_FIELDS");
});

test("manifest: unmapped placeholder is included, marked mapped=false", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "T",
    documentKind: "GENERIC",
    version: 1,
    status: "DRAFT",
    htmlBody: `<<Unmapped_field>>`,
    mappings: [],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.CURRENT_FIELDS,
  });
  assert.equal(manifest.placeholders[0].mapped, false);
  assert.equal(manifest.placeholders[0].sourceType, "UNMAPPED");
});

test("README-AI: documents placeholder syntax, case-sensitivity, and layout rules", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "Đăng ký tập nghề",
    documentKind: "B",
    version: 8,
    status: "PUBLISHED",
    htmlBody: SAMPLE_HTML,
    mappings: [mapping()],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });
  const readme = buildReadmeAi(manifest);
  assert.match(readme, /<<Ten_placeholder>>/);
  assert.match(readme, /\{\{Ten_placeholder\}\}/);
  assert.match(readme, /PHÂN BIỆT CHỮ HOA\/THƯỜNG|case-sensitive/i);
  assert.match(readme, /min-height/);
  assert.match(readme, /overflow: hidden/);
  assert.match(readme, /white-space: nowrap/);
  assert.match(readme, /position: absolute/);
  assert.match(readme, /break-inside/);
  assert.match(readme, /Ho_ten/); // actual placeholder list included
  assert.match(readme, /A4/);
});

test("README-AI: lists every placeholder from the manifest", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "T",
    documentKind: "B",
    version: 1,
    status: "PUBLISHED",
    htmlBody: `<<A>><<B>><<C>>`,
    mappings: [mapping({ placeholder: "A" }), mapping({ placeholder: "B" }), mapping({ placeholder: "C" })],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });
  const readme = buildReadmeAi(manifest);
  for (const key of ["A", "B", "C"]) {
    assert.match(readme, new RegExp(`<<${key}>>`));
  }
});

test("export package: contains exactly the 4 required files with exact names", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "T",
    documentKind: "B",
    version: 1,
    status: "PUBLISHED",
    htmlBody: SAMPLE_HTML,
    mappings: [mapping()],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });
  const files = buildAiExportFiles(manifest, SAMPLE_HTML, ".page { width: 100%; }");
  assert.deepEqual(
    files.map((f) => f.name).sort(),
    ["README-AI.md", "print.css", "template-manifest.json", "template.html"],
  );
});

test("export package: manifest.json is valid, parseable JSON", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "T",
    documentKind: "B",
    version: 1,
    status: "PUBLISHED",
    htmlBody: SAMPLE_HTML,
    mappings: [mapping()],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });
  const files = buildAiExportFiles(manifest, SAMPLE_HTML, "");
  const manifestFile = files.find((f) => f.name === "template-manifest.json")!;
  const parsed = JSON.parse(manifestFile.content);
  assert.equal(parsed.templateId, "tpl-1");
});

test("export package: contains NO candidate PII (no name/CCCD/phone/address VALUES — only field labels)", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "Đăng ký tập nghề",
    documentKind: "B",
    version: 8,
    status: "PUBLISHED",
    htmlBody: SAMPLE_HTML,
    mappings: [mapping({ placeholder: "Ho_ten" }), mapping({ placeholder: "Dia_chi_thuong_tru", sourcePath: "permanentAddress" })],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });
  const files = buildAiExportFiles(manifest, SAMPLE_HTML, "");
  const combined = files.map((f) => f.content).join("\n");
  // A real CCCD is 12 digits; a real Vietnamese phone number is 10 digits
  // starting with 0. The manifest/README must never contain such a value —
  // only field KEYS/LABELS (e.g. "Số CCCD"), never a VALUE.
  assert.doesNotMatch(combined, /\b\d{12}\b/, "no 12-digit CCCD-shaped value");
  assert.doesNotMatch(combined, /\b0\d{9}\b/, "no 10-digit phone-shaped value");
});

test("export package: contains NO secrets/env values (DATABASE_URL, API keys, tokens)", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "T",
    documentKind: "B",
    version: 1,
    status: "PUBLISHED",
    htmlBody: SAMPLE_HTML,
    mappings: [mapping()],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });
  const files = buildAiExportFiles(manifest, SAMPLE_HTML, "");
  const combined = files.map((f) => f.content).join("\n");
  assert.doesNotMatch(combined, /postgres(ql)?:\/\//i);
  assert.doesNotMatch(combined, /DATABASE_URL/i);
  assert.doesNotMatch(combined, /\bAKIA[0-9A-Z]{16}\b/); // AWS access key shape
  assert.doesNotMatch(combined, /\bsk-[A-Za-z0-9]{20,}\b/); // API-secret-key shape
  assert.doesNotMatch(combined, /process\.env/);
});

test("export package: only known, expected keys appear in the manifest JSON shape (no accidental extra fields)", () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "T",
    documentKind: "B",
    version: 1,
    status: "PUBLISHED",
    htmlBody: `<<A>>`,
    mappings: [mapping({ placeholder: "A" })],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });
  const allowedTopLevel = new Set([
    "contractVersion", "templateId", "templateName", "documentKind", "version",
    "status", "mappingSource", "generatedAt", "placeholderCount", "placeholders",
  ]);
  for (const key of Object.keys(manifest)) assert.ok(allowedTopLevel.has(key), `unexpected manifest key: ${key}`);
  const allowedPlaceholderKeys = new Set([
    "key", "required", "mapped", "label", "sourceType", "sourceField", "sourcePath", "optionValue", "formatType",
  ]);
  for (const key of Object.keys(manifest.placeholders[0])) {
    assert.ok(allowedPlaceholderKeys.has(key), `unexpected placeholder field: ${key}`);
  }
});

test("buildAiExportZip: produces a valid ZIP buffer (local file header signature)", async () => {
  const buf = await buildAiExportZip([{ name: "a.txt", content: "hello" }]);
  assert.ok(buf.length > 0);
  // ZIP local file header magic number: 0x50 0x4B 0x03 0x04 ("PK\x03\x04").
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4b);
  assert.equal(buf[2], 0x03);
  assert.equal(buf[3], 0x04);
});

test("buildAiExportZip: zipping a full export package round-trips all 4 filenames", async () => {
  const manifest = buildTemplateManifest({
    templateId: "tpl-1",
    templateName: "T",
    documentKind: "B",
    version: 1,
    status: "PUBLISHED",
    htmlBody: SAMPLE_HTML,
    mappings: [mapping()],
    mappingSource: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
  });
  const files = buildAiExportFiles(manifest, SAMPLE_HTML, ".x{color:red}");
  const buf = await buildAiExportZip(files);
  const text = buf.toString("latin1");
  for (const file of files) assert.ok(text.includes(file.name), `zip missing entry ${file.name}`);
});
