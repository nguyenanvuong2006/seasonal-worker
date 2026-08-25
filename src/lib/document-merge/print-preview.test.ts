/**
 * PRINT-ONLY PREVIEW VIEW — regression tests.
 *
 * These lock the deterministic print path for the visual PDF acceptance gate:
 *   1. the print action targets the RENDERED Preview document (never the admin
 *      page, never a later candidate selection);
 *   2. nothing is printed before a Preview is actually rendered;
 *   3. the print-only view re-uses the canonical Preview document (body + A4
 *      print CSS intact) and only ADDS a screen-only toolbar + a window.print();
 *   4. the mobile-safe fallback (manual "Mở bản in") exists and does not auto
 *      print, while the primary path auto-opens the dialog;
 *   5. no admin chrome can leak into the print document.
 *
 * There is no DB / no job / no publish anywhere in this module — the route tests
 * (print-preview-route.test.ts) prove those invariants end-to-end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PRINT_VIEW_AUTO_PRINT,
  PRINT_VIEW_PATH,
  buildPrintViewUrl,
  canOpenPrintView,
  hasRenderedPreview,
  injectPrintTooling,
  resolvePreviewApplicationId,
} from "./print-preview.ts";

/** The kind of full standalone document `renderCanonicalDocument` produces. */
const RENDERED_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<style>
@page { size: A4; margin: 12mm 12mm; }
.paper { width: 210mm; }
</style>
</head>
<body>
<div class="paper"><h1>GIẤY ĐĂNG KÝ TẬP NGHỀ</h1><p>Họ tên: Trần Văn Dũng</p></div>
<div class="paper regulations-page"><p>QUY ĐỊNH VỀ TẬP NGHỀ</p></div>
</body>
</html>`;

test("hasRenderedPreview is true only when a non-empty renderedHtml exists", () => {
  assert.equal(hasRenderedPreview({ renderedHtml: RENDERED_HTML }), true);
  assert.equal(hasRenderedPreview({ renderedHtml: "   \n " }), false, "whitespace-only is not a preview");
  assert.equal(hasRenderedPreview({ renderedHtml: "" }), false);
  assert.equal(hasRenderedPreview({}), false);
  assert.equal(hasRenderedPreview(null), false);
  assert.equal(hasRenderedPreview({ renderedHtml: undefined }), false);
});

test("resolvePreviewApplicationId prefers the id that rendered the current preview", () => {
  assert.equal(resolvePreviewApplicationId("app-rendered", "app-selected"), "app-rendered");
  assert.equal(resolvePreviewApplicationId("", "app-selected"), "app-selected");
  assert.equal(resolvePreviewApplicationId(null, "app-selected"), "app-selected");
  assert.equal(resolvePreviewApplicationId("app-rendered", null), "app-rendered");
  assert.equal(resolvePreviewApplicationId(null, null), null);
  assert.equal(resolvePreviewApplicationId("", ""), null);
});

test("canOpenPrintView is false before a Preview has rendered (never prints a wrong/blank document)", () => {
  assert.equal(canOpenPrintView(null, "app-1", "app-1"), false);
  assert.equal(canOpenPrintView({}, "app-1", "app-1"), false);
  assert.equal(canOpenPrintView({ renderedHtml: "" }, "app-1", "app-1"), false);
  assert.equal(canOpenPrintView({ renderedHtml: "   " }, "app-1", "app-1"), false, "whitespace is not a Preview");
});

test("canOpenPrintView is true only when a Preview exists AND a candidate id is present", () => {
  assert.equal(canOpenPrintView({ renderedHtml: RENDERED_HTML }, "app-rendered", "app-1"), true);
  // It falls back to the selected candidate when the rendered id is absent.
  assert.equal(canOpenPrintView({ renderedHtml: RENDERED_HTML }, null, "app-1"), true);
  // If neither the rendered nor the selected id exists, nothing may be printed.
  assert.equal(canOpenPrintView({ renderedHtml: RENDERED_HTML }, null, null), false);
});

test("buildPrintViewUrl targets the explicit template/version/app, not the published pointer", () => {
  const url = buildPrintViewUrl({
    templateId: "tpl-1",
    versionId: "ver-8",
    applicationId: "app-42",
    autoPrint: true,
  });
  assert.ok(url.startsWith("/api/document-merge/templates/tpl-1/versions/ver-8/print?"), url);
  assert.ok(url.includes("applicationId=app-42"), url);
  assert.ok(url.includes(`autoprint=${PRINT_VIEW_AUTO_PRINT}`), url);
  // The explicit version identity lives in the path; there is no published pointer.
  assert.ok(url.includes("/versions/ver-8/print"), url);
  assert.match(url, /^\/api\/document-merge\/templates\/[^/]+\/versions\/[^?/]+\/print\?/);
});

test("buildPrintViewUrl URL-encodes templateId/versionId/applicationId", () => {
  const url = buildPrintViewUrl({
    templateId: "tpl/a b",
    versionId: "ver 8",
    applicationId: "app 42",
    autoPrint: false,
  });
  assert.ok(url.includes("templates/tpl%2Fa%20b"), url);
  assert.ok(url.includes("versions/ver%208"), url);
  // URLSearchParams encodes a space as '+' in the query string.
  assert.ok(url.includes("applicationId=app+42") || url.includes("applicationId=app%2042"), url);
  assert.ok(!url.includes("autoprint="), "no autoprint when autoPrint is false");
});

test("buildPrintViewUrl uses the canonical route path constant", () => {
  assert.match(PRINT_VIEW_PATH, /\/api\/document-merge\/templates\/:templateId\/versions\/:versionId\/print/);
  assert.ok(!PRINT_VIEW_PATH.includes("current_published_version"));
});

test("injectPrintTooling keeps the canonical document body and A4 print CSS intact", () => {
  const out = injectPrintTooling(RENDERED_HTML, {
    templateName: "Giấy đăng ký tập nghề", version: 8, versionStatus: "DRAFT", fullName: "Trần Văn Dũng",
  });
  assert.ok(out.includes("GIẤY ĐĂNG KÝ TẬP NGHỀ"), "the merged document body must remain");
  assert.ok(out.includes("Họ tên: Trần Văn Dũng"), "the real candidate value must remain");
  assert.ok(out.includes("QUY ĐỊNH VỀ TẬP NGHỀ"));
  assert.ok(out.includes("@page { size: A4; margin: 12mm 12mm; }"), "A4 print CSS preserved");
  assert.ok(out.includes(".paper { width: 210mm; }"), "document print CSS preserved");
  assert.ok(out.includes("<!DOCTYPE html>"));
});

test("injectPrintTooling adds a screen-only toolbar hidden at print time", () => {
  const out = injectPrintTooling(RENDERED_HTML, {
    templateName: "Mẫu", version: 8, versionStatus: "DRAFT", fullName: "A", cccd: "1",
  });
  assert.ok(out.includes('class="print-toolbar"'), "toolbar present");
  assert.ok(out.includes("In / Lưu PDF"), "toolbar has the print button");
  assert.match(out, /@media print\s*\{\s*\.print-toolbar[^}]*display:\s*none\s*!important/);
  assert.match(out, /\.print-toolbar\s*\{[^}]*position:\s*sticky/);
});

test("injectPrintTooling adds a print script that wires the button and calls window.print()", () => {
  const out = injectPrintTooling(RENDERED_HTML, {
    templateName: "Mẫu", version: 8, versionStatus: "DRAFT", fullName: null,
  });
  assert.ok(out.includes("window.print()"), "script must call the native print dialog");
  assert.match(out, /addEventListener\('click'/);
  assert.match(out, /getElementById\('pt-print-btn'\)/);
});

test("injectPrintTooling auto-prints on load only with data-autoprint=1", () => {
  const auto = injectPrintTooling(RENDERED_HTML, {
    templateName: "Mẫu", version: 8, versionStatus: "DRAFT", fullName: "Trần Văn Dũng",
  }, { autoPrint: true });
  assert.ok(auto.includes('data-autoprint="1"'), "primary path asks the view to auto-open the dialog");

  const manual = injectPrintTooling(RENDERED_HTML, {
    templateName: "Mẫu", version: 8, versionStatus: "DRAFT", fullName: "Trần Văn Dũng",
  }, { autoPrint: false });
  assert.ok(!manual.includes('data-autoprint="1"'), "fallback path must not auto-print");
  assert.ok(manual.includes("window.print()"), "but still offers the in-page button");
});

test("injectPrintTooling escapes toolbar metadata and never renders admin chrome", () => {
  const out = injectPrintTooling(RENDERED_HTML, {
    templateName: `<script>alert(1)</script>`,
    version: 8,
    versionStatus: "DRAFT",
    fullName: `X "<img onerror=alert(1)>`,
    cccd: "0",
  });
  assert.ok(!out.includes("alert(1)<"), "toolbar metadata must be escaped");
  assert.ok(out.includes("&lt;script&gt;"), "escaped template name");
  assert.ok(out.includes("&lt;img"), "escaped candidate data");
  // No admin page chrome: no sidebar nav / admin header strings.
  assert.ok(!out.includes("Danh sách Mẫu tài liệu"));
  assert.ok(!out.includes("Trộn tài liệu"));
});

test("injectPrintTooling is defensive when the document has no <body>", () => {
  const out = injectPrintTooling("<html><head><style>.x{}</style></head>CONTENT</html>", {
    templateName: "Mẫu", version: 1, versionStatus: "DRAFT", fullName: null,
  });
  assert.ok(out.includes("print-toolbar"));
  assert.ok(out.includes("CONTENT"), "original content still present");
});

test("injectPrintTooling reports the version & mapping-free safety note in the toolbar", () => {
  const out = injectPrintTooling(RENDERED_HTML, {
    templateName: "Giấy đăng ký tập nghề", version: 8, versionStatus: "PUBLISHED", fullName: "Trần Văn Dũng",
  });
  // The version shown is the EXPLICIT one being printed, and the toolbar states
  // the read-only contract.
  assert.ok(out.includes("v8 (PUBLISHED)"));
  assert.ok(out.includes("Không tạo job, không ghi DB, không publish."));
});

/* -------------------------------------------------------------------- *
 * DEFECT A FIX (Phase 4/11) — unresolved-placeholder warning in the
 * print toolbar. Shared with unsaved-preview's JSON field via the SAME
 * unresolved-placeholder-guard.ts module (print parity).
 * ------------------------------------------------------------------- */

test("injectPrintTooling with no `warning` renders no warning banner element (unchanged default behavior)", () => {
  const out = injectPrintTooling(RENDERED_HTML, {
    templateName: "Giấy đăng ký tập nghề", version: 8, versionStatus: "PUBLISHED",
  });
  assert.doesNotMatch(out, /<div class="pt-warning">/);
});

test("injectPrintTooling with `warning` set renders a prominent banner carrying the exact text", () => {
  const out = injectPrintTooling(RENDERED_HTML, {
    templateName: "Giấy đăng ký tập nghề",
    version: 10,
    versionStatus: "DRAFT · CHƯA LƯU",
    warning: "⚠ CẢNH BÁO: còn 2 trường chưa được thay thế — xem chi tiết trong bản xem trước trước khi in.",
  });
  assert.match(out, /<div class="pt-warning">/);
  assert.match(out, /còn 2 trường chưa được thay thế/);
});

test("injectPrintTooling escapes the warning text (defence in depth against injected markup)", () => {
  const out = injectPrintTooling(RENDERED_HTML, {
    templateName: "T", version: 1, versionStatus: "DRAFT",
    warning: `<script>evil()</script>`,
  });
  assert.doesNotMatch(out, /<script>evil\(\)<\/script>/);
  assert.match(out, /&lt;script&gt;/);
});
