/**
 * HTML print template engine — tests (Phase 2).
 * Kiểm tra: renderer + template Dang_ky_tap_nghe dùng đúng canonical placeholder,
 * render đủ 51 placeholder, @page A4, escape giá trị (chống XSS).
 */

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { A4_PRINT_CSS, escapeHtml, renderApplicantHtml, wrapHtmlDocument } from "./html-renderer.ts";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";
import { dangKyTapNgheTemplate } from "../../document-templates/dang-ky-tap-nghe/template.ts";
import { PLACEHOLDERS } from "../../document-templates/dang-ky-tap-nghe/schema.ts";

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
});

describe("Dang_ky_tap_nghe template", () => {
  it("chứa đủ 51 canonical placeholder", () => {
    const found = extractUniquePlaceholders(dangKyTapNgheTemplate.html);
    for (const p of PLACEHOLDERS) {
      assert.ok(found.includes(p), `thiếu placeholder ${p}`);
    }
    // Không có placeholder lạ ngoài danh sách canonical.
    for (const f of found) {
      assert.ok((PLACEHOLDERS as readonly string[]).includes(f), `placeholder lạ ${f}`);
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
