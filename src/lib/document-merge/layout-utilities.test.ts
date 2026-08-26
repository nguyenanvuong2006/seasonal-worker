/**
 * LAYOUT CAPABILITY UTILITIES (v12) — three opt-in, class-scoped CSS
 * capabilities: `.equal-columns-2`, `.keep-with-next-small`, `.variable-length`.
 * They are additive to A4_PRINT_CSS; no existing template references them, so
 * their presence must be a no-op for every already-PUBLISHED template.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { A4_PRINT_CSS, LAYOUT_UTILITY_CSS, wrapHtmlDocument, renderApplicantHtmlFromParts } from "./html-renderer.ts";
import { analyzeTemplateLayout } from "./ai-template-layout.ts";

test("LAYOUT_UTILITY_CSS exposes all three scoped layout utilities", () => {
  assert.match(LAYOUT_UTILITY_CSS, /\.equal-columns-2\s*\{[^}]*display:\s*grid/);
  assert.match(LAYOUT_UTILITY_CSS, /\.keep-with-next-small\s*\{[^}]*page-break-after:\s*avoid/);
  assert.match(LAYOUT_UTILITY_CSS, /\.variable-length\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test("utilities are class-scoped (never broad tag selectors) so the layout scanner cannot flag them", () => {
  const html = `
    <div class="equal-columns-2">
      <span>Họ và Tên: {{Ho_ten}}</span>
      <span>Sinh ngày: {{Ngay_sinh}}</span>
    </div>
    <div class="keep-with-next-small">III/ CAM KẾT</div>
    <p class="variable-length">{{Dia_chi_thuong_tru}}</p>
  `;
  // The utilities are the ONLY CSS under analysis here — a broad `break-inside`
  // / `page-break-inside` selector would raise GLOBAL_BREAK_INSIDE_AVOID. The
  // scoped `.keep-with-next-small` uses break-after (a different property) and
  // is class-scoped, so nothing is flagged.
  const warnings = analyzeTemplateLayout(html, LAYOUT_UTILITY_CSS);
  assert.deepEqual(
    warnings.filter((w) => w.code === "GLOBAL_BREAK_INSIDE_AVOID"),
    [],
  );
});

test("wrapHtmlDocument always injects the utilities alongside the base print CSS", () => {
  const html = wrapHtmlDocument("<p>hi</p>", "");
  assert.match(html, /\.equal-columns-2/);
  assert.match(html, /\.keep-with-next-small/);
  assert.match(html, /\.variable-length/);
});

test("variable-length allows long values to wrap without a NOWRAP/OVERFLOW warning", () => {
  const html = `<div class="variable-length">{{Dia_chi_thuong_tru}}</div>`;
  const warnings = analyzeTemplateLayout(html, LAYOUT_UTILITY_CSS);
  const codes = warnings.map((w) => w.code);
  assert.equal(codes.includes("NOWRAP_DYNAMIC_CONTENT"), false);
  assert.equal(codes.includes("OVERFLOW_HIDDEN_DYNAMIC_CONTENT"), false);
});

test("equal-columns-2 renders two equal side-by-side columns with no unreplaced placeholders", () => {
  const result = renderApplicantHtmlFromParts(
    `<div class="equal-columns-2"><span>Họ và Tên: {{Ho_ten}}</span><span>Sinh ngày: {{Ngay_sinh}}</span></div>`,
    "",
    { Ho_ten: "An Vượng", Ngay_sinh: "01/01/2000" },
  );
  assert.equal(result.unreplaced.length, 0);
  assert.match(result.html, /An Vượng/);
  assert.match(result.html, /01\/01\/2000/);
  assert.match(result.html, /grid-template-columns:\s*1fr 1fr/);
});
