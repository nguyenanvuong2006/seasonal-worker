import test from "node:test";
import assert from "node:assert/strict";
import { A4_PREVIEW_SHEET_DECORATION_CSS, decoratePreviewForA4Sheets } from "./preview-a4-decoration.ts";

test("decoratePreviewForA4Sheets: injects the decoration style right before </head>", () => {
  const html = `<!DOCTYPE html><html><head><style>.paper{width:210mm}</style></head><body><div class="paper">x</div></body></html>`;
  const out = decoratePreviewForA4Sheets(html);
  assert.ok(out.includes(A4_PREVIEW_SHEET_DECORATION_CSS), "decoration CSS must be present in the output");
  assert.ok(out.indexOf(A4_PREVIEW_SHEET_DECORATION_CSS) < out.indexOf("</head>"), "decoration must land before </head>, not after");
  // The original canonical <style> block must be untouched, not replaced.
  assert.ok(out.includes(".paper{width:210mm}"), "canonical print CSS must never be removed/altered");
});

test("decoratePreviewForA4Sheets: never mutates the canonical body content", () => {
  const html = `<html><head></head><body><div class="page"><p>Nguyễn Văn A — <<Nguoi_tiep_nhan>></p></div></body></html>`;
  const out = decoratePreviewForA4Sheets(html);
  assert.ok(out.includes(`<p>Nguyễn Văn A — <<Nguoi_tiep_nhan>></p>`), "body content must be byte-identical, decoration is CSS-only");
});

test("decoratePreviewForA4Sheets: falls back to prepending when there is no </head>", () => {
  const html = `<div class="page">no head tag at all</div>`;
  const out = decoratePreviewForA4Sheets(html);
  assert.ok(out.startsWith(`<style>${A4_PREVIEW_SHEET_DECORATION_CSS}</style>`));
  assert.ok(out.includes(`<div class="page">no head tag at all</div>`));
});

test("decoratePreviewForA4Sheets: idempotent — calling twice does not duplicate the decoration", () => {
  const html = `<html><head></head><body><div class="paper">x</div></body></html>`;
  const once = decoratePreviewForA4Sheets(html);
  const twice = decoratePreviewForA4Sheets(once);
  assert.equal(twice, once);
  const occurrences = twice.split(A4_PREVIEW_SHEET_DECORATION_CSS).length - 1;
  assert.equal(occurrences, 1, "decoration CSS must appear exactly once even after a second call");
});

test("decoration CSS targets BOTH .page (canonical shared class) and .paper (trainee-registration template class) — no template family is left undecorated", () => {
  assert.match(A4_PREVIEW_SHEET_DECORATION_CSS, /\.page,\s*\.paper\s*\{/);
  assert.match(A4_PREVIEW_SHEET_DECORATION_CSS, /\.page::before,\s*\.paper::before\s*\{/);
});

test("decoration CSS uses a CSS counter (Trang N labels) — no JS/DOM required to number pages", () => {
  assert.match(A4_PREVIEW_SHEET_DECORATION_CSS, /counter-reset:\s*dm-preview-page/);
  assert.match(A4_PREVIEW_SHEET_DECORATION_CSS, /counter-increment:\s*dm-preview-page/);
  assert.match(A4_PREVIEW_SHEET_DECORATION_CSS, /content:\s*"Trang "\s*counter\(dm-preview-page\)/);
});

test("decoration CSS does not use zoom/scale/transform hacks to fit content — sheets render at natural size", () => {
  assert.doesNotMatch(A4_PREVIEW_SHEET_DECORATION_CSS, /\bzoom\s*:/i);
  assert.doesNotMatch(A4_PREVIEW_SHEET_DECORATION_CSS, /transform\s*:\s*scale/i);
});
