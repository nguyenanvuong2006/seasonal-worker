import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFullDocument } from "./full-document-analyze.ts";
import { toMappingSemantics, type MappingSemantics } from "./template-diff.ts";

function mappingFor(placeholder: string): MappingSemantics {
  return toMappingSemantics({ placeholder, sourceType: "CORE_FIELD", sourcePath: placeholder, isRequired: false, isOrphaned: false });
}

test("PHASE 14 FIX: reproduces and fixes the exact operator-reported anomaly (49 total, 0 unchanged, 0 added, 49 removed) — malformed early empty <body> no longer discards the pasted content", () => {
  const placeholders = Array.from({ length: 49 }, (_, i) => `Field_${String(i + 1).padStart(2, "0")}`);
  const baseHtml = `<div class="page">${placeholders.map((p) => `<p><<${p}>></p>`).join("")}</div>`;
  const mappings = placeholders.map((p) => mappingFor(p));
  // The malformed shape that reproduced the anomaly: a stray, EMPTY <body>
  // pair before the real content, itself wrapped in a second <body> tag.
  const malformedRawHtml = `<!DOCTYPE html><html><head><style>.page{width:210mm}</style></head><body></body>some stray text<body><div class="page">${placeholders
    .map((p) => `<p><<${p}>></p>`)
    .join("")}</div></body></html>`;

  const result = analyzeFullDocument({ rawHtml: malformedRawHtml, baseHtml, baseMappings: mappings, currentMappings: mappings });

  assert.equal(result.placeholders.total, 49);
  assert.equal(result.placeholders.unchanged, 49, "the SAME 49 placeholders, re-pasted with malformed wrapper markup, must report unchanged");
  assert.equal(result.placeholders.added, 0);
  assert.equal(result.placeholders.removed, 0, "the real content must never be silently discarded as 'removed'");
  assert.equal(result.mappingsAffected, 0);
});

test("DIFF 7: unchanged placeholders across a full-document re-paste -> zero remapping requested", () => {
  const placeholders = ["Ho_ten", "Dia_chi_thuong_tru", "So_CCCD"];
  const baseHtml = `<div>${placeholders.map((p) => `<<${p}>>`).join("")}</div>`;
  const rawHtml = `<!DOCTYPE html><html><head><style>.a{color:red}</style></head><body><table>${placeholders
    .map((p) => `<tr><td><<${p}>></td></tr>`)
    .join("")}</table></body></html>`;
  const mappings = placeholders.map(mappingFor);

  const result = analyzeFullDocument({ rawHtml, baseHtml, baseMappings: mappings, currentMappings: mappings });
  assert.equal(result.placeholders.total, 3);
  assert.equal(result.placeholders.unchanged, 3);
  assert.equal(result.placeholders.added, 0);
  assert.equal(result.placeholders.removed, 0);
  assert.equal(result.mappingsAffected, 0);
});

test("DIFF 8: adding one placeholder in the pasted document -> exactly one ADDED", () => {
  const baseHtml = `<div><<Ho_ten>></div>`;
  const rawHtml = `<html><body><div><<Ho_ten>><<Ngay_sinh>></div></body></html>`;
  const mappings = [mappingFor("Ho_ten")];

  const result = analyzeFullDocument({ rawHtml, baseHtml, baseMappings: mappings, currentMappings: mappings });
  assert.equal(result.placeholders.added, 1);
  assert.equal(result.placeholders.removed, 0);
});

test("DIFF 9: removing one placeholder in the pasted document -> exactly one REMOVED", () => {
  const baseHtml = `<div><<Ho_ten>><<Ngay_sinh>></div>`;
  const rawHtml = `<html><body><div><<Ho_ten>></div></body></html>`;
  const mappings = [mappingFor("Ho_ten"), mappingFor("Ngay_sinh")];

  const result = analyzeFullDocument({ rawHtml, baseHtml, baseMappings: mappings, currentMappings: mappings });
  assert.equal(result.placeholders.added, 0);
  assert.equal(result.placeholders.removed, 1);
});

test("DIFF 10: case-sensitive placeholder rename is detected as remove+add, not silently unchanged", () => {
  const baseHtml = `<div><<Ho_ten>></div>`;
  const rawHtml = `<html><body><div><<HO_TEN>></div></body></html>`;
  const mappings = [mappingFor("Ho_ten")];

  const result = analyzeFullDocument({ rawHtml, baseHtml, baseMappings: mappings, currentMappings: mappings });
  assert.equal(result.placeholders.added, 1);
  assert.equal(result.placeholders.removed, 1);
});

test("full document mode: body extracted, style blocks combined into printCss, external stylesheet flagged separately from other normalization notices", () => {
  const rawHtml = `<!DOCTYPE html>
<html>
<head>
<style>.a{color:red}</style>
<link rel="stylesheet" href="https://cdn.example.com/x.css">
</head>
<body><body><div><<Ho_ten>></div></body></body>
</html>`;
  const result = analyzeFullDocument({ rawHtml, baseHtml: `<<Ho_ten>>`, baseMappings: [mappingFor("Ho_ten")], currentMappings: [mappingFor("Ho_ten")] });

  assert.match(result.normalizedHtmlBody, /<<Ho_ten>>/);
  assert.match(result.normalizedPrintCss, /\.a\{color:red\}/);
  assert.equal(result.externalResourceWarnings.length, 1);
  assert.equal(result.externalResourceWarnings[0].code, "EXTERNAL_STYLESHEET_IGNORED");
  assert.equal(result.normalizationWarnings.length, 1);
  assert.equal(result.normalizationWarnings[0].code, "MULTIPLE_BODY_TAGS_FOUND");
});

test("advanced split-editor mode (bare fragment + explicitCss) is unaffected by normalization: pass-through body, explicitCss preserved verbatim", () => {
  const rawHtml = `<div><<Ho_ten>></div>`;
  const explicitCss = ".a{color:blue}";
  const result = analyzeFullDocument({ rawHtml, explicitCss, baseHtml: `<<Ho_ten>>`, baseMappings: [mappingFor("Ho_ten")], currentMappings: [mappingFor("Ho_ten")] });
  assert.equal(result.normalizedHtmlBody, rawHtml);
  assert.equal(result.normalizedPrintCss, explicitCss);
  assert.deepEqual(result.normalizationWarnings, []);
  assert.deepEqual(result.externalResourceWarnings, []);
});

test("analysisHash: deterministic for identical normalized content, differs when content changes", () => {
  const base = { baseHtml: `<<Ho_ten>>`, baseMappings: [mappingFor("Ho_ten")], currentMappings: [mappingFor("Ho_ten")] };
  const a = analyzeFullDocument({ rawHtml: `<html><body><<Ho_ten>></body></html>`, ...base });
  const b = analyzeFullDocument({ rawHtml: `<html><body><<Ho_ten>></body></html>`, ...base });
  const c = analyzeFullDocument({ rawHtml: `<html><body><<Ho_ten>><<Ngay_sinh>></body></html>`, ...base });

  assert.equal(a.analysisHash, b.analysisHash);
  assert.notEqual(a.analysisHash, c.analysisHash);
  assert.match(a.analysisHash, /^[0-9a-f]{64}$/);
});

test("analysisHash covers CSS too: same body, different CSS -> different hash", () => {
  const base = { baseHtml: `<<Ho_ten>>`, baseMappings: [mappingFor("Ho_ten")], currentMappings: [mappingFor("Ho_ten")] };
  const a = analyzeFullDocument({ rawHtml: `<html><head><style>.a{color:red}</style></head><body><<Ho_ten>></body></html>`, ...base });
  const b = analyzeFullDocument({ rawHtml: `<html><head><style>.a{color:blue}</style></head><body><<Ho_ten>></body></html>`, ...base });
  assert.notEqual(a.analysisHash, b.analysisHash);
});

test("security/layout analysis still runs on the NORMALIZED body (script tag inside pasted full document still blocked)", () => {
  const rawHtml = `<html><body><script>evil()</script><<Ho_ten>></body></html>`;
  const result = analyzeFullDocument({ rawHtml, baseHtml: `<<Ho_ten>>`, baseMappings: [mappingFor("Ho_ten")], currentMappings: [mappingFor("Ho_ten")] });
  assert.ok(result.security.errors.some((e) => e.code === "SCRIPT_TAG"));
});

test("PHASE 14 FIX regression / SECURITY 36: the multi-body 'first non-empty span' selection cannot be used to bypass security scanning — a script hidden in the SELECTED span is still blocked, and an empty decoy span before it changes nothing", () => {
  const rawHtml = `<html><body></body>decoy<body><script>evil()</script><<Ho_ten>></body></html>`;
  const result = analyzeFullDocument({ rawHtml, baseHtml: `<<Ho_ten>>`, baseMappings: [mappingFor("Ho_ten")], currentMappings: [mappingFor("Ho_ten")] });
  assert.match(result.normalizedHtmlBody, /<script>evil\(\)<\/script>/);
  assert.ok(result.security.errors.some((e) => e.code === "SCRIPT_TAG"));
});

test("SECURITY 35: inline event handler (onclick) remains blocked in full-document paste mode", () => {
  const rawHtml = `<html><body><div onclick="steal()"><<Ho_ten>></div></body></html>`;
  const result = analyzeFullDocument({ rawHtml, baseHtml: `<<Ho_ten>>`, baseMappings: [mappingFor("Ho_ten")], currentMappings: [mappingFor("Ho_ten")] });
  assert.ok(result.security.errors.some((e) => e.code === "INLINE_EVENT_HANDLER"));
});
