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
  renderApplicantHtml,
  renderApplicantHtmlFromParts,
  stripPreviewOnlyMarkup,
  wrapHtmlDocument,
} from "./html-renderer.ts";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";
import { dangKyTapNgheTemplate } from "../../document-templates/dang-ky-tap-nghe/template.ts";
import { PLACEHOLDERS, REJECTED_ORPHAN_PLACEHOLDERS } from "../../document-templates/dang-ky-tap-nghe/schema.ts";

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
    const result = renderApplicantHtml(dangKyTapNgheTemplate, { ...allFieldValues(), Ho_ten: "A <b>& C" });
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
    const found = extractUniquePlaceholders(dangKyTapNgheTemplate.html);
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
    const result = renderApplicantHtml(dangKyTapNgheTemplate, allFieldValues());
    assert.equal(result.unreplaced.length, 0, `còn placeholder: ${result.unreplaced.join(", ")}`);
    assert.match(result.html, /size: A4/);
    assert.match(result.html, /GIẤY ĐĂNG KÝ TẬP NGHỀ/);
  });

  it("render thiếu giá trị → phát hiện unreplaced (mapping thiếu)", () => {
    const partial = allFieldValues();
    delete partial.Ho_ten;
    const result = renderApplicantHtml(dangKyTapNgheTemplate, partial);
    assert.ok(result.unreplaced.includes("Ho_ten"));
  });
});
