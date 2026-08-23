/**
 * PHASE 6 — Google Doc → canonical HTML draft sync.
 *
 * Proves the migration mechanism creates a DRAFT only, preserves structure and
 * placeholders, and STOPS with a reported limitation rather than publishing an
 * approximation when the export cannot represent the approved document.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANONICAL_SYNC_ACTION_LABEL,
  CanonicalSyncError,
  canonicalSyncSourceName,
  convertGoogleDocHtmlToCanonical,
  countLogicalSections,
} from "./canonical-sync.ts";

const STRUCTURED_EXPORT = `<!DOCTYPE html><html><head>
<style>.page{width:210mm}.b{font-weight:700}</style>
<meta name="generator" content="Google Docs"><link rel="stylesheet" href="x.css">
</head><body>
<script>alert(1)</script>
<div class="page"><h1>GIẤY ĐĂNG KÝ TẬP NGHỀ</h1>
<p>Họ và tên: <span class="merge-value">{{Ho_ten}}</span></p>
<table><tr><td>CCCD</td><td>{{So_CCCD}}</td></tr></table></div>
<div class="page"><h2>QUY ĐỊNH</h2><p>Ngày: {{Ngay_nhan_viec}}</p></div>
</body></html>`;

test("converts a structured Google Doc export into canonical HTML + print CSS", () => {
  const result = convertGoogleDocHtmlToCanonical(STRUCTURED_EXPORT, "doc-123");

  assert.match(result.htmlBody, /GIẤY ĐĂNG KÝ TẬP NGHỀ/);
  assert.match(result.htmlBody, /<table>/);
  assert.match(result.printCss, /\.page\{width:210mm\}/);
  assert.equal(result.sourceDocId, "doc-123");
});

test("preserves supported structure, styles and placeholders", () => {
  const result = convertGoogleDocHtmlToCanonical(STRUCTURED_EXPORT, "doc-123");

  assert.deepEqual(result.placeholders.sort(), ["Ho_ten", "Ngay_nhan_viec", "So_CCCD"]);
  assert.equal(result.logicalPageCount, 2);
  assert.match(result.printCss, /font-weight:700/);
});

test("strips scripts and non-document chrome as defence in depth", () => {
  const result = convertGoogleDocHtmlToCanonical(STRUCTURED_EXPORT, "doc-123");

  assert.doesNotMatch(result.htmlBody, /<script/i);
  assert.doesNotMatch(result.htmlBody, /alert\(1\)/);
  assert.doesNotMatch(result.htmlBody, /<link/i);
  assert.doesNotMatch(result.htmlBody, /<meta/i);
  // The document body itself must survive intact.
  assert.match(result.htmlBody, /Họ và tên/);
});

test("STOPS instead of approximating when the export is not structured (text/plain)", () => {
  const plain = "GIAY DANG KY TAP NGHE\n\nHo va ten: {{Ho_ten}}\nCCCD: {{So_CCCD}}";
  assert.throws(
    () => convertGoogleDocHtmlToCanonical(plain, "doc-123"),
    (error: unknown) => {
      assert.ok(error instanceof CanonicalSyncError);
      assert.equal(error.code, "GOOGLE_DOC_EXPORT_NOT_STRUCTURED");
      assert.match(error.operatorMessage, /dừng lại/);
      assert.ok(error.limitations.length > 0, "the limitation must be reported");
      return true;
    },
  );
});

test("STOPS on an empty export", () => {
  assert.throws(() => convertGoogleDocHtmlToCanonical("   ", "doc-123"), /GOOGLE_DOC_EXPORT_EMPTY/);
});

test("reports fidelity warnings without blocking review", () => {
  const noCss = `<html><body><div class="page"><p>{{Ho_ten}}</p>
    <img src="https://example.com/logo.png"></div></body></html>`;
  const result = convertGoogleDocHtmlToCanonical(noCss, "doc-9");

  assert.ok(result.warnings.some((w) => /CSS in/.test(w)), "missing print CSS must be flagged");
  assert.ok(result.warnings.some((w) => /ảnh/.test(w)), "external images must be flagged");
});

test("reports placeholder drift against the existing catalog", () => {
  const result = convertGoogleDocHtmlToCanonical(STRUCTURED_EXPORT, "doc-123", {
    expectedPlaceholders: ["Ho_ten", "So_CCCD", "Dia_chi_thuong_tru"],
  });

  assert.ok(result.warnings.some((w) => /Thiếu placeholder/.test(w) && /Dia_chi_thuong_tru/.test(w)));
  assert.ok(result.warnings.some((w) => /placeholder mới/.test(w) && /Ngay_nhan_viec/.test(w)));
});

test("logical section count is derived, never assumed", () => {
  assert.equal(countLogicalSections('<div class="page">a</div><div class="page">b</div>'), 2);
  assert.equal(countLogicalSections('<p style="page-break-before: always">x</p>'), 2);
  assert.equal(countLogicalSections("<p>single</p>"), 1);
  const seven = Array.from({ length: 7 }, () => '<div class="page">x</div>').join("");
  assert.equal(countLogicalSections(seven), 7);
});

test("draft provenance is auditable and explicitly marked unpublished", () => {
  const name = canonicalSyncSourceName("doc-123", new Date("2026-08-23T10:00:00Z"));
  assert.match(name, /google-doc:doc-123/);
  assert.match(name, /DRAFT/);
  assert.match(name, /chưa xuất bản/);
  assert.equal(CANONICAL_SYNC_ACTION_LABEL, "Đồng bộ Google Doc → phiên bản HTML mới");
});

test("the sync module never publishes and never mutates historical versions", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/document-merge/canonical-sync.ts"), "utf8");
  assert.doesNotMatch(source, /publishTemplateVersion|'PUBLISHED'|"PUBLISHED"/);
  assert.doesNotMatch(source, /\bUPDATE\b|\bDELETE\b/i);
});
