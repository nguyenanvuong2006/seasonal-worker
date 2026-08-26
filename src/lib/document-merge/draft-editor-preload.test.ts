import test from "node:test";
import assert from "node:assert/strict";
import { composeFullHtmlDocument, isDraftEditorDirty } from "./draft-editor-preload.ts";
import { normalizeFullHtmlDocument } from "./full-document-normalizer.ts";

test("composeFullHtmlDocument: v13 DRAFT html_body ends up inside <body>, byte-preserved", () => {
  const htmlBody = `<div class="page"><p>Nguyễn Văn A — <<Ho_ten>></p></div>`;
  const out = composeFullHtmlDocument(htmlBody, "");
  assert.ok(out.includes(htmlBody), "html_body content must appear verbatim in the composed document");
  assert.ok(out.includes("<body>"));
  assert.ok(out.includes("</body>"));
});

test("composeFullHtmlDocument: v13 DRAFT print_css ends up inside a <style> block, byte-preserved", () => {
  const printCss = `.page{width:210mm} .signature{page-break-inside:avoid}`;
  const out = composeFullHtmlDocument("<p>x</p>", printCss);
  assert.ok(out.includes(printCss), "print_css content must appear verbatim in the composed document");
  assert.match(out, /<style>[\s\S]*<\/style>/);
});

test("composeFullHtmlDocument: empty print_css omits the <style> block entirely (no empty tag noise)", () => {
  const out = composeFullHtmlDocument("<p>x</p>", "");
  assert.ok(!out.includes("<style>"));
});

test("composeFullHtmlDocument: round-trips through normalizeFullHtmlDocument back to the same html_body/print_css", () => {
  const htmlBody = `<div class="page"><<Ho_ten>> — <<Ngay_ky>></div>`;
  const printCss = `.page{width:210mm;margin:0 auto}`;
  const composed = composeFullHtmlDocument(htmlBody, printCss);
  const normalized = normalizeFullHtmlDocument(composed);
  assert.equal(normalized.htmlBody.trim(), htmlBody.trim());
  assert.equal(normalized.extractedCss.trim(), printCss.trim());
  assert.equal(normalized.warnings.length, 0);
});

test("composeFullHtmlDocument: null-ish parts never throw and never emit the literal string 'null'/'undefined'", () => {
  const out = composeFullHtmlDocument(null as unknown as string, null as unknown as string);
  assert.ok(!out.includes("null"));
  assert.ok(!out.includes("undefined"));
});

test("isDraftEditorDirty: false when nothing has been touched since load (modal just opened)", () => {
  const dirty = isDraftEditorDirty({
    html: "<p>v13 body</p>",
    css: ".page{}",
    rawPaste: "",
    baselineHtml: "<p>v13 body</p>",
    baselineCss: ".page{}",
    baselineRawPaste: "",
  });
  assert.equal(dirty, false);
});

test("isDraftEditorDirty: true after editing the advanced-mode HTML textarea", () => {
  const dirty = isDraftEditorDirty({
    html: "<p>v13 body EDITED</p>",
    css: ".page{}",
    rawPaste: "",
    baselineHtml: "<p>v13 body</p>",
    baselineCss: ".page{}",
    baselineRawPaste: "",
  });
  assert.equal(dirty, true);
});

test("isDraftEditorDirty: true after editing the advanced-mode CSS textarea", () => {
  const dirty = isDraftEditorDirty({
    html: "<p>v13 body</p>",
    css: ".page{color:red}",
    rawPaste: "",
    baselineHtml: "<p>v13 body</p>",
    baselineCss: ".page{}",
    baselineRawPaste: "",
  });
  assert.equal(dirty, true);
});

test("isDraftEditorDirty: true after typing/pasting into the paste-mode box, even while advanced mode is untouched", () => {
  const dirty = isDraftEditorDirty({
    html: "<p>v13 body</p>",
    css: ".page{}",
    rawPaste: "<html>...</html>",
    baselineHtml: "<p>v13 body</p>",
    baselineCss: ".page{}",
    baselineRawPaste: "",
  });
  assert.equal(dirty, true);
});

test("isDraftEditorDirty: false again right after 'Khôi phục nội dung đã lưu' resets baseline == current", () => {
  // Simulates clicking "Nạp HTML hiện tại" / "Khôi phục nội dung đã lưu": the
  // baseline is advanced forward to match whatever was just (re)loaded, so a
  // load action itself never counts as a dirty edit.
  const composed = composeFullHtmlDocument("<p>v13 body</p>", ".page{}");
  const dirty = isDraftEditorDirty({
    html: "<p>v13 body</p>",
    css: ".page{}",
    rawPaste: composed,
    baselineHtml: "<p>v13 body</p>",
    baselineCss: ".page{}",
    baselineRawPaste: composed,
  });
  assert.equal(dirty, false);
});
