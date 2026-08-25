import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFullHtmlDocument } from "./full-document-normalizer.ts";

test("NORMALIZATION 1: complete HTML document is parsed without throwing", () => {
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title></head><body><p>Hello</p></body></html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.equal(result.htmlBody.trim(), "<p>Hello</p>");
});

test("NORMALIZATION 2: body content is extracted, doctype/head/html tags excluded", () => {
  const doc = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>body{color:red}</style></head>
<body>
<div class="page"><<Ho_ten>></div>
</body>
</html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.doesNotMatch(result.htmlBody, /<!DOCTYPE/i);
  assert.doesNotMatch(result.htmlBody, /<head>/i);
  assert.doesNotMatch(result.htmlBody, /<\/html>/i);
  assert.match(result.htmlBody, /<div class="page"><<Ho_ten>><\/div>/);
});

test("NORMALIZATION 3: multiple <style> blocks are preserved, in document order", () => {
  const doc = `<html><head><style>.a{color:red}</style></head><body><style>.b{color:blue}</style><p>x</p></body></html>`;
  const result = normalizeFullHtmlDocument(doc);
  const aIndex = result.extractedCss.indexOf(".a{color:red}");
  const bIndex = result.extractedCss.indexOf(".b{color:blue}");
  assert.ok(aIndex >= 0 && bIndex >= 0, "both style blocks must be present");
  assert.ok(aIndex < bIndex, "head style block must precede body style block");
});

test("NORMALIZATION 4: doctype/head/meta handled without breaking body extraction", () => {
  const doc = `<!DOCTYPE html>\n<html lang="vi">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width">\n<title>Mau</title>\n</head>\n<body>\n<p>Noi dung</p>\n</body>\n</html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.equal(result.htmlBody.trim(), "<p>Noi dung</p>");
  assert.deepEqual(result.warnings, []);
});

test("NORMALIZATION 5: external stylesheet <link> produces a warning and its content is never fetched/inlined", () => {
  const doc = `<html><head><link rel="stylesheet" href="https://example.com/style.css"></head><body><p>x</p></body></html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "EXTERNAL_STYLESHEET_IGNORED");
  assert.equal(result.warnings[0].href, "https://example.com/style.css");
  assert.doesNotMatch(result.extractedCss, /example\.com/);
});

test("NORMALIZATION 5b: <link rel=stylesheet> without href still warns with a placeholder message, never throws", () => {
  const doc = `<html><head><link rel="stylesheet"></head><body><p>x</p></body></html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "EXTERNAL_STYLESHEET_IGNORED");
});

test("NORMALIZATION 5c: non-stylesheet <link> (e.g. icon) produces no warning", () => {
  const doc = `<html><head><link rel="icon" href="favicon.ico"></head><body><p>x</p></body></html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.deepEqual(result.warnings, []);
});

test("NORMALIZATION 6: <<Ho_ten>> is never parsed as an HTML tag and is preserved exactly, including case", () => {
  const doc = `<html><body><p>Ten: <<Ho_ten>></p><p>Dia chi: <<Dia_chi_thuong_tru>></p><p>legacy: {{Ho_Ten}}</p></body></html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.match(result.htmlBody, /<<Ho_ten>>/);
  assert.match(result.htmlBody, /<<Dia_chi_thuong_tru>>/);
  assert.match(result.htmlBody, /\{\{Ho_Ten\}\}/);
  assert.doesNotMatch(result.htmlBody, /<<ho_ten>>/, "case must be preserved, not lowercased");
});

test("bare fragment (no <body> tag at all) passes through unchanged with zero warnings", () => {
  const fragment = `<div class="page"><p><<Ho_ten>></p></div>`;
  const result = normalizeFullHtmlDocument(fragment);
  assert.equal(result.htmlBody, fragment);
  assert.equal(result.extractedCss, "");
  assert.deepEqual(result.warnings, []);
});

test("empty string input does not throw and returns empty body", () => {
  const result = normalizeFullHtmlDocument("");
  assert.equal(result.htmlBody, "");
  assert.equal(result.extractedCss, "");
  assert.deepEqual(result.warnings, []);
});

test("multiple <body> tags: first <body>...first </body> after it wins, and a warning is produced", () => {
  const doc = `<html><body><p>first</p></body><body><p>second</p></body></html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.match(result.htmlBody, /first/);
  assert.doesNotMatch(result.htmlBody, /second/);
  assert.equal(result.warnings.some((w) => w.code === "MULTIPLE_BODY_TAGS_FOUND"), true);
});

test("unterminated <body> (no closing tag) extracts to end of input, no crash", () => {
  const doc = `<html><body><p>unterminated content <<Ho_ten>>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.match(result.htmlBody, /unterminated content <<Ho_ten>>/);
});

test("self-closing-looking <body/> (selfClosing true) is not treated as an open boundary", () => {
  // Defensive: body is not a void element, so this should not normally occur,
  // but the normalizer must not throw regardless of malformed input.
  const doc = `<html><body/><p>after</p></html>`;
  assert.doesNotThrow(() => normalizeFullHtmlDocument(doc));
});

/* -------------------------------------------------------------------- *
 * PHASE 14 FIX — "49 removed, 0 added" anomaly.
 *
 * ROOT CAUSE (confirmed by direct reproduction): a malformed AI response
 * with an early, EMPTY <body></body> pair before the REAL content (itself
 * wrapped in a second <body> tag) caused the old "first <body> open, first
 * </body> after it" rule to extract NOTHING — every real placeholder
 * silently vanished from the analyzed "current" body, and the (correct)
 * diff engine then reported the base's placeholders as 100% REMOVED with
 * 0 ADDED, exactly matching the operator's report. This was a normalizer
 * extraction bug, NOT a diff-engine bug, NOT a base-version-selection bug,
 * and NOT a UI wording issue — buildTemplateDiff/analyzeTemplate/
 * analyzeFullDocument's base/current argument order was code-reviewed and
 * confirmed correct throughout.
 * ------------------------------------------------------------------- */

test("PHASE 14 FIX: an early EMPTY <body></body> before the REAL content (wrapped in a second <body>) no longer discards the real content", () => {
  const doc = `<!DOCTYPE html><html><head><style>.page{width:210mm}</style></head><body></body>some stray text<body><div class="page"><<Ho_ten>><<Dia_chi_thuong_tru>></div></body></html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.match(result.htmlBody, /<<Ho_ten>>/);
  assert.match(result.htmlBody, /<<Dia_chi_thuong_tru>>/);
  assert.equal(result.warnings.some((w) => w.code === "MULTIPLE_BODY_TAGS_FOUND"), true);
});

test("PHASE 14 FIX: immediately-nested <body><body>...</body></body> (no stray text between) still extracts the real inner content, not the literal text of the second open tag", () => {
  const doc = `<body><body><div><<Ho_ten>></div></body></body>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.match(result.htmlBody, /<<Ho_ten>>/);
  assert.doesNotMatch(result.htmlBody, /^<body>$/);
});

test("PHASE 14 FIX: three <body> tags, only the LAST one non-empty, still finds the real content", () => {
  const doc = `<body></body><body>   </body><body><<Ho_ten>></body>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.match(result.htmlBody, /<<Ho_ten>>/);
});

test("DEFECT B AUDIT: the normalizer never touches CSS content — .no-border class/rule and border declarations pass through byte-for-byte", () => {
  const doc = `<!DOCTYPE html>
<html><head><style>
.no-border, .no-border th, .no-border td { border: none; }
.official-table, .official-table td { border: 2px solid #000; }
</style></head>
<body>
<table class="no-border"><tr><td>Người lao động</td><td>Đại diện công ty</td></tr></table>
<table class="official-table"><tr><td>Mẫu chính thức</td></tr></table>
</body></html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.match(result.extractedCss, /\.no-border,\s*\.no-border th,\s*\.no-border td\s*\{\s*border:\s*none;\s*\}/);
  assert.match(result.extractedCss, /\.official-table,\s*\.official-table td\s*\{\s*border:\s*2px solid #000;\s*\}/);
  assert.match(result.htmlBody, /class="no-border"/);
  assert.match(result.htmlBody, /class="official-table"/);
  // No injected border rule of any kind — the normalizer is a pure
  // extraction, never a CSS author.
  assert.doesNotMatch(result.extractedCss, /(^|\n)\s*table\s*,?\s*td\s*,?\s*th\s*\{\s*border/);
});

test("realistic AI-revised full document: doctype + head + multiple styles + body with many placeholders", () => {
  const doc = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<style>
  .page { break-before: page; }
  table { width: 100%; }
</style>
<link rel="stylesheet" href="https://fonts.example.com/font.css">
<style>
  .label-col { width: 35mm; font-weight: bold; }
</style>
</head>
<body>
<div class="page">
  <table>
    <tr><td class="label-col">Ho va ten</td><td><<Ho_ten>></td></tr>
    <tr><td class="label-col">Dia chi</td><td><<Dia_chi_thuong_tru>></td></tr>
  </table>
</div>
</body>
</html>`;
  const result = normalizeFullHtmlDocument(doc);
  assert.match(result.htmlBody, /<<Ho_ten>>/);
  assert.match(result.htmlBody, /<<Dia_chi_thuong_tru>>/);
  assert.doesNotMatch(result.htmlBody, /<style>/);
  assert.match(result.extractedCss, /break-before: page/);
  assert.match(result.extractedCss, /label-col \{ width: 35mm/);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "EXTERNAL_STYLESHEET_IGNORED");
});
