import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTemplateLayout } from "./ai-template-layout.ts";

function codesOf(warnings: ReturnType<typeof analyzeTemplateLayout>) {
  return warnings.map((w) => w.code);
}

test("layout: fixed height around a dynamic placeholder warns", () => {
  const html = `<table><tr><td style="height:24px"><<Dia_chi_tam_tru>></td></tr></table>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.ok(codesOf(warnings).includes("FIXED_HEIGHT_DYNAMIC_CONTENT"));
});

test("layout: fixed height with NO dynamic content (photo box) does NOT warn", () => {
  const html = `<div class="photo-box" style="height:120px;width:90px;border:1px solid #000"></div>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.deepEqual(codesOf(warnings), []);
});

test("layout: fixed height with NO dynamic content (blank signature space) does NOT warn", () => {
  const html = `<div class="signature-space" style="height:60px">&nbsp;</div>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.deepEqual(codesOf(warnings), []);
});

test("layout: fixed height via a CSS class rule (not inline) around a placeholder still warns", () => {
  const html = `<td class="addr"><<Dia_chi_tam_tru>></td>`;
  const css = `.addr { height: 24px; }`;
  const warnings = analyzeTemplateLayout(html, css);
  assert.ok(codesOf(warnings).includes("FIXED_HEIGHT_DYNAMIC_CONTENT"));
});

test("layout: min-height (not height) around dynamic content does not trigger fixed-height warning", () => {
  const html = `<td style="min-height:24px"><<Dia_chi_tam_tru>></td>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.equal(codesOf(warnings).filter((c) => c === "FIXED_HEIGHT_DYNAMIC_CONTENT").length, 0);
});

test("layout: overflow:hidden around dynamic content warns", () => {
  const html = `<div style="overflow:hidden"><<Dia_chi_tam_tru>></div>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.ok(codesOf(warnings).includes("OVERFLOW_HIDDEN_DYNAMIC_CONTENT"));
});

test("layout: overflow:hidden with no dynamic content does not warn", () => {
  const html = `<div style="overflow:hidden">Ảnh 3x4</div>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.deepEqual(codesOf(warnings), []);
});

test("layout: white-space:nowrap around dynamic content warns", () => {
  const html = `<span style="white-space:nowrap"><<Dia_chi_thuong_tru>></span>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.ok(codesOf(warnings).includes("NOWRAP_DYNAMIC_CONTENT"));
});

test("layout: position:absolute around dynamic content warns", () => {
  const html = `<div style="position:absolute;top:10px;left:10px"><<Ho_ten>></div>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.ok(codesOf(warnings).includes("ABSOLUTE_POSITION_DYNAMIC_CONTENT"));
});

test("layout: position:static (default) around dynamic content does not warn", () => {
  const html = `<div style="position:static"><<Ho_ten>></div>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.equal(codesOf(warnings).filter((c) => c === "ABSOLUTE_POSITION_DYNAMIC_CONTENT").length, 0);
});

test("layout: table width beyond printable A4 area warns (not placeholder-gated)", () => {
  const html = `<table style="width:250mm"><tr><td>static</td></tr></table>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.ok(codesOf(warnings).includes("TABLE_WIDTH_EXCEEDS_A4"));
});

test("layout: table width within printable A4 area does not warn", () => {
  const html = `<table style="width:180mm"><tr><td>static</td></tr></table>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.equal(codesOf(warnings).filter((c) => c === "TABLE_WIDTH_EXCEEDS_A4").length, 0);
});

test("layout: percentage width never triggers the A4-width warning", () => {
  const html = `<table style="width:100%"><tr><td>static</td></tr></table>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.equal(codesOf(warnings).filter((c) => c === "TABLE_WIDTH_EXCEEDS_A4").length, 0);
});

/* -------------------------------------------------------------------- *
 * PHASE 8/9 (width model) — PAGE_CONTAINER (.page/.paper) vs CONTENT.
 * The outer A4 page wrapper legitimately spans ~210mm (the physical sheet);
 * only content NESTED inside it must fit the ~186mm printable area.
 * ------------------------------------------------------------------- */

test("width 20: outer .page at 210mm is the physical A4 sheet — not falsely warned", () => {
  const html = `<div class="page" style="width:210mm"><p>static</p></div>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.equal(codesOf(warnings).filter((c) => c === "TABLE_WIDTH_EXCEEDS_A4").length, 0);
});

test("width: outer .paper (v7 authoring-shell page marker) at 210mm is also not falsely warned", () => {
  const html = `<div class="paper" style="width:210mm"><p>static</p></div>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.equal(codesOf(warnings).filter((c) => c === "TABLE_WIDTH_EXCEEDS_A4").length, 0);
});

test("width 21: a nested child of width 210mm INSIDE a .page (child itself has no page/paper class) is warned", () => {
  const html = `<div class="page" style="width:210mm"><table style="width:210mm"><tr><td>static</td></tr></table></div>`;
  const warnings = analyzeTemplateLayout(html, "");
  const widthWarnings = warnings.filter((w) => w.code === "TABLE_WIDTH_EXCEEDS_A4");
  // Exactly the nested <table>, not the outer .page.
  assert.equal(widthWarnings.length, 1);
  assert.equal(widthWarnings[0].tagName, "table");
});

test("width: a .page far beyond the true A4 physical width (e.g. 250mm) is still warned — the page-container exemption is not unlimited", () => {
  const html = `<div class="page" style="width:250mm"><p>static</p></div>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.ok(codesOf(warnings).includes("TABLE_WIDTH_EXCEEDS_A4"));
});

test("width 22: width:100% content nested inside a 210mm .page is safe and not warned", () => {
  const html = `<div class="page" style="width:210mm"><table style="width:100%"><tr><td>static</td></tr></table></div>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.equal(codesOf(warnings).filter((c) => c === "TABLE_WIDTH_EXCEEDS_A4").length, 0);
});

test("width 23: box-sizing:border-box does not change the width-model evaluation — outer occupied width is still the declared width", () => {
  const bordered = `<table style="width:200mm;box-sizing:border-box;padding:10mm"><tr><td>static</td></tr></table>`;
  const warningsBordered = analyzeTemplateLayout(bordered, "");
  assert.ok(
    codesOf(warningsBordered).includes("TABLE_WIDTH_EXCEEDS_A4"),
    "box-sizing:border-box must not exempt a 200mm content element from the printable-width check — the OUTER box is still 200mm",
  );

  const contentBox = `<table style="width:200mm;box-sizing:content-box"><tr><td>static</td></tr></table>`;
  const warningsContentBox = analyzeTemplateLayout(contentBox, "");
  assert.ok(codesOf(warningsContentBox).includes("TABLE_WIDTH_EXCEEDS_A4"));
});

test("layout: broad/global break-inside:avoid warns", () => {
  const css = `td { break-inside: avoid; }`;
  const warnings = analyzeTemplateLayout("<table><tr><td>x</td></tr></table>", css);
  assert.ok(codesOf(warnings).includes("GLOBAL_BREAK_INSIDE_AVOID"));
});

test("layout: broad page-break-inside:avoid (legacy property) warns", () => {
  const css = `div { page-break-inside: avoid; }`;
  const warnings = analyzeTemplateLayout("<div>x</div>", css);
  assert.ok(codesOf(warnings).includes("GLOBAL_BREAK_INSIDE_AVOID"));
});

test("layout: SCOPED break-inside:avoid (specific class) does not warn", () => {
  const css = `.signature-block { break-inside: avoid; }`;
  const warnings = analyzeTemplateLayout(`<div class="signature-block">x</div>`, css);
  assert.equal(codesOf(warnings).filter((c) => c === "GLOBAL_BREAK_INSIDE_AVOID").length, 0);
});

test("layout: short vs long dynamic data does not change warning count (analyzer inspects markup, not runtime data)", () => {
  const htmlShort = `<td style="height:24px"><<Dia_chi_tam_tru>></td>`;
  const short = analyzeTemplateLayout(htmlShort, "");
  assert.equal(codesOf(short).filter((c) => c === "FIXED_HEIGHT_DYNAMIC_CONTENT").length, 1);
});

test("layout: nested element inside a fixed-height ancestor still triggers the ancestor warning", () => {
  const html = `<td style="height:24px"><span class="wrap"><<Dia_chi_tam_tru>></span></td>`;
  const warnings = analyzeTemplateLayout(html, "");
  assert.ok(codesOf(warnings).includes("FIXED_HEIGHT_DYNAMIC_CONTENT"));
});

test("layout: realistic safe template (no fixed sizing around dynamic data) produces zero warnings", () => {
  const html = `
    <div class="page">
      <table style="width:100%">
        <tr><td>Họ tên</td><td><<Ho_ten>></td></tr>
        <tr><td>Địa chỉ</td><td><<Dia_chi_thuong_tru>></td></tr>
      </table>
      <div class="photo-box" style="height:120px;width:90px"></div>
    </div>`;
  const css = `.page { width: 100%; } table { width: 100%; } td { padding: 4px; }`;
  const warnings = analyzeTemplateLayout(html, css);
  assert.deepEqual(warnings, []);
});
