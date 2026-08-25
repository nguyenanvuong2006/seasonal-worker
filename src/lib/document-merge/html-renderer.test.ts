/**
 * HTML print template engine — tests (Phase 2).
 * Kiểm tra: renderer + template Dang_ky_tap_nghe dùng đúng canonical placeholder,
 * render đủ 49 placeholder active, @page A4, escape giá trị (chống XSS).
 */

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  A4_PRINT_CSS,
  escapeHtml,
  renderApplicantHtmlFromParts,
  stripPreviewOnlyMarkup,
  wrapHtmlDocument,
} from "./html-renderer.ts";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";
import { PLACEHOLDERS, REJECTED_ORPHAN_PLACEHOLDERS } from "../../document-templates/dang-ky-tap-nghe/schema.ts";
import { readCanonicalVersionParts } from "../test-support/canonical-fixture.ts";

/** Canonical body/CSS come from the DB payload, never from a runtime module. */
const canonical = readCanonicalVersionParts();

/** Render the canonical body exactly the way production does. */
function renderCanonical(values: Record<string, string>) {
  return renderApplicantHtmlFromParts(canonical.htmlBody, canonical.printCss, values);
}

function allFieldValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const p of PLACEHOLDERS) values[p] = `VAL_${p}`;
  // Checkbox placeholders nhận ☒/☐ thay vì text.
  for (const key of Object.keys(values)) {
    if (/_Co$|_Khong$|_Nhan_vien$|_Cong_nhan$|_Lao_dong_tap_nghe$|_Da_Lat$|_Da_Quy$|_Da_Ron$|_Lam_Ha$|_Khac$|_Sinh_vien$|_Da_co$|_Chua_co$|_Chi_DHF$|_Ngoai_DHF$|_Trong_cham_soc_thu_hoach$|_Ban_hang$|_Dong_goi$/.test(key)) {
      values[key] = "☐";
    }
  }
  return values;
}

describe("HTML renderer", () => {
  it("bọc body + css thành document hoàn chỉnh với @page A4", () => {
    const html = wrapHtmlDocument("<p>hi</p>", ".x{}");
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<meta charset="utf-8"/);
    assert.match(html, /size: A4/);
  });

  it("escapeHtml chống XSS / markup vỡ", () => {
    assert.equal(escapeHtml(`<script>&"'`), "&lt;script&gt;&amp;&quot;&#39;");
  });

  it("giá trị có ký tự HTML được escape trong output", () => {
    const result = renderCanonical({ ...allFieldValues(), Ho_ten: "A <b>& C" });
    assert.match(result.html, /A &lt;b&gt;&amp; C/);
    assert.doesNotMatch(result.html, /A <b>& C/);
  });

  it("renders both {{semantic}} and legacy <<semantic>> placeholders without candidate markup", () => {
    const result = renderApplicantHtmlFromParts(
      "<p>{{Ho_ten}} / <<Dia_chi_thuong_tru>></p>",
      "",
      { Ho_ten: "Nguyễn <img src=x onerror=alert(1)>", Dia_chi_thuong_tru: "Đà Lạt" },
    );
    assert.equal(result.unreplaced.length, 0);
    assert.match(result.html, /Nguyễn &lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(result.html, /Đà Lạt/);
  });

  it("strips preview/navigation/code UI and retains only print document content", () => {
    const source = [
      "<div class=\"toolbar\"><button onclick=\"window.print()\">Print</button></div>",
      "<div class=\"code-panel\"><pre>{{debug_only}}</pre></div>",
      "<div class=\"nav-tabs\"><button>Tabs</button></div>",
      "<div class=\"page-label\">Trang 1</div>",
      "<nav>Navigation</nav><aside class=\"template-code\">code</aside>",
      "<p data-preview-only>highlight</p><p onclick=\"alert(1)\">Giấy tờ</p><script>evil()</script>",
    ].join("");
    assert.equal(stripPreviewOnlyMarkup(source), "<p>Giấy tờ</p>");
    const rendered = renderApplicantHtmlFromParts(source, "", {});
    assert.match(rendered.html, /Giấy tờ/);
    assert.doesNotMatch(rendered.html, /toolbar|code-panel|nav-tabs|page-label|<nav\b|<button\b|debug_only|onclick=|<script\b/);
  });

  it("A4 print CSS uses logical section breaks and safe wrapping for long Vietnamese text", () => {
    assert.match(A4_PRINT_CSS, /size: A4/);
    assert.match(A4_PRINT_CSS, /\.page \+ \.page/);
    assert.match(A4_PRINT_CSS, /break-before: page/);
    assert.match(A4_PRINT_CSS, /overflow-wrap: anywhere/);
    const longAddress = "Tổ dân phố Hòa Bình, phường Trường An, thành phố Huế, tỉnh Thừa Thiên Huế ".repeat(8);
    const result = renderApplicantHtmlFromParts("<table><tr><td>{{Dia_chi_thuong_tru}}</td></tr></table>", "", { Dia_chi_thuong_tru: longAddress });
    assert.equal(result.unreplaced.length, 0);
    assert.match(result.html, /Tổ dân phố Hòa Bình/);
    assert.match(result.html, /table-layout: fixed/);
  });
});

describe("Dang_ky_tap_nghe template", () => {
  it("chứa đúng 49 placeholder active và loại 2 orphan hợp đồng dịch vụ thuế", () => {
    const found = extractUniquePlaceholders(canonical.htmlBody);
    assert.equal(found.length, 49);
    assert.equal(PLACEHOLDERS.length, 49);
    for (const p of PLACEHOLDERS) {
      assert.ok(found.includes(p), `thiếu placeholder ${p}`);
    }
    for (const f of found) {
      assert.ok((PLACEHOLDERS as readonly string[]).includes(f), `placeholder lạ ${f}`);
    }
    for (const orphan of REJECTED_ORPHAN_PLACEHOLDERS) {
      assert.equal(found.includes(orphan), false, `orphan ${orphan} vẫn còn trong HTML`);
      assert.equal((PLACEHOLDERS as readonly string[]).includes(orphan), false);
    }
  });

  it("render đầy đủ → không còn placeholder, có @page A4", () => {
    const result = renderCanonical(allFieldValues());
    assert.equal(result.unreplaced.length, 0, `còn placeholder: ${result.unreplaced.join(", ")}`);
    assert.match(result.html, /size: A4/);
    assert.match(result.html, /GIẤY ĐĂNG KÝ TẬP NGHỀ/);
  });

  it("render thiếu giá trị → phát hiện unreplaced (mapping thiếu)", () => {
    const partial = allFieldValues();
    delete partial.Ho_ten;
    const result = renderCanonical(partial);
    assert.ok(result.unreplaced.includes("Ho_ten"));
  });
});

/* ==================================================================== *
 * DEFECT B — TABLE BORDER FIDELITY.
 *
 * ROOT CAUSE (confirmed by code audit): A4_PRINT_CSS unconditionally sets
 * `th, td { border: 1px solid #000 }` for EVERY table, regardless of what
 * the submitted HTML/CSS says — this is a deliberate default so official
 * form tables print with visible grid lines out of the box, and REMOVING it
 * globally would silently strip borders from every already-PUBLISHED
 * template (v8 and earlier) that relies on it. The escape hatch already
 * exists: `.no-border, .no-border th, .no-border td { border: none }`,
 * scoped by class so it can never affect a table that doesn't opt in.
 * These tests lock BOTH halves of that contract in place.
 * ==================================================================== */
describe("Table border fidelity (Defect B)", () => {
  it("A4_PRINT_CSS defaults every td/th to a visible 1px border — preserves ALL existing PUBLISHED templates", () => {
    assert.match(A4_PRINT_CSS, /th,\s*td\s*\{[^}]*border:\s*1px solid #000/);
  });

  it("A4_PRINT_CSS provides a class-scoped `.no-border` escape hatch for layout-only tables", () => {
    assert.match(A4_PRINT_CSS, /\.no-border,\s*\.no-border th,\s*\.no-border td\s*\{\s*border:\s*none;\s*\}/);
  });

  it("REGRESSION GUARD: no unscoped global rule ever forces borders OFF for every table (would silently break intentionally-bordered official forms)", () => {
    assert.doesNotMatch(A4_PRINT_CSS, /(^|\n)\s*table\s*,?\s*td\s*,?\s*th\s*\{\s*border:\s*none/);
  });

  it("a plain <table> with no class keeps the default bordered rendering (canonical output carries the default rule; no submitted CSS suppresses it)", () => {
    const html = renderApplicantHtmlFromParts(`<table><tr><td>Người lao động</td></tr></table>`, "", {}).html;
    assert.match(html, /th,\s*td\s*\{[^}]*border:\s*1px solid #000/);
    assert.doesNotMatch(html, /class="[^"]*no-border[^"]*"/);
  });

  it("a signature/date layout table marked class=\"no-border\" carries the override rule that wins over the default (higher specificity: .no-border td > td)", () => {
    const html = renderApplicantHtmlFromParts(
      `<table class="no-border"><tr><td>Người lao động</td><td>Đại diện công ty</td></tr></table>`,
      "",
      {},
    ).html;
    assert.match(html, /class="no-border"/);
    // Both the default rule AND the higher-specificity override are present —
    // a real browser resolves `.no-border td` (specificity 0-1-1) over the
    // bare `td` (0-0-1), so the table renders borderless despite the default.
    assert.match(html, /th,\s*td\s*\{[^}]*border:\s*1px solid #000/);
    assert.match(html, /\.no-border,\s*\.no-border th,\s*\.no-border td\s*\{\s*border:\s*none;\s*\}/);
  });

  it("an operator's OWN scoped CSS rule for a specific bordered official-form table is preserved verbatim, never stripped by the normalizer/renderer", () => {
    const submittedCss = `.official-table, .official-table td, .official-table th { border: 2px solid #000; }`;
    const html = renderApplicantHtmlFromParts(`<table class="official-table"><tr><td>Mẫu chính thức</td></tr></table>`, submittedCss, {}).html;
    assert.match(html, /\.official-table,\s*\.official-table td,\s*\.official-table th\s*\{\s*border:\s*2px solid #000;\s*\}/);
  });

  it("submitted CSS explicitly requesting border:none on a specific table is preserved (source-order-wins for equal specificity, appended AFTER the default rule)", () => {
    const submittedCss = `.sig-layout, .sig-layout td, .sig-layout th { border: none; }`;
    const html = renderApplicantHtmlFromParts(`<table class="sig-layout"><tr><td>Chữ ký</td></tr></table>`, submittedCss, {}).html;
    const styleBlock = html.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "";
    const defaultIdx = styleBlock.indexOf("th, td {");
    const submittedIdx = styleBlock.indexOf(".sig-layout");
    assert.ok(defaultIdx >= 0 && submittedIdx >= 0);
    assert.ok(submittedIdx > defaultIdx, "submitted CSS must be appended AFTER the default so equal-specificity overrides apply");
  });
});
