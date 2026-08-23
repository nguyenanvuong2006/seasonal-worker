/**
 * Integration checks for the same Playwright/Chromium PDF stack deployed by
 * the worker. They skip only when the browser binary is absent; Cloud Run's
 * Playwright image executes them with the production browser revision.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import { renderApplicantHtmlFromParts } from "../../src/lib/document-merge/html-renderer.ts";
import { CHECKBOX_PLACEHOLDERS, PLACEHOLDERS } from "../../src/document-templates/dang-ky-tap-nghe/schema.ts";
import {
  readCanonicalManifest,
  readCanonicalVersionParts,
} from "../../src/lib/test-support/canonical-fixture.ts";

const executablePath = chromium.executablePath();
const chromiumAvailable = existsSync(executablePath);

test("HTML → Playwright PDF: Unicode, A4 size and explicit two-page pagination", { skip: !chromiumAvailable }, async () => {
  const { html, unreplaced } = renderApplicantHtmlFromParts(
    `
      <section class="page"><h1>GIẤY TỜ TIẾNG VIỆT</h1><p>{{Ho_ten}}</p><p>{{Dia_chi}}</p></section>
      <section class="page"><h1>TRANG HAI</h1><p><span class="chk">{{Da_xac_nhan}}</span> Xác nhận</p></section>
    `,
    "",
    {
      Ho_ten: "Nguyễn Thị Ánh Dương",
      Dia_chi: "Phường 8, thành phố Đà Lạt, tỉnh Lâm Đồng",
      Da_xac_nhan: "☒",
    },
  );
  assert.deepEqual(unreplaced, []);

  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(async () => document.fonts.ready);
    const bytes = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    assert.ok(bytes.byteLength > 1000, "must generate a non-empty PDF");

    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 2, "logical page sections must not produce an accidental trailing blank page");
    const [first] = pdf.getPages();
    assert.ok(Math.abs(first.getWidth() - 595.28) < 1, `A4 width: ${first.getWidth()}`);
    assert.ok(Math.abs(first.getHeight() - 841.89) < 1, `A4 height: ${first.getHeight()}`);
  } finally {
    await browser.close();
  }
});

function canonicalFieldValues(): Record<string, string> {
  const values: Record<string, string> = Object.fromEntries(
    PLACEHOLDERS.map((placeholder) => [placeholder, `Giá trị ${placeholder}`]),
  );
  Object.assign(values, {
    Ho_ten: "Nguyễn Thị Ánh Dương",
    Ngay_sinh: "15/03/2001",
    Dia_chi_thuong_tru: "Số 12, đường Trần Phú, phường 3, thành phố Đà Lạt, tỉnh Lâm Đồng",
    Dia_chi_tam_tru: "Tổ dân phố Hòa Bình, phường Trường An, thành phố Huế, tỉnh Thừa Thiên Huế",
    So_dien_thoai: "0912345678",
    So_CCCD: "072201012345",
    Ngay_cap_CCCD: "10/01/2022",
    Noi_cap_CCCD: "Cục Cảnh sát quản lý hành chính về trật tự xã hội",
    Ngay_nhan_viec: "01/09/2026",
    Ngay_tiep_nhan: "01/09/2026",
    Nguoi_tiep_nhan: "Phòng Hành chính – Nhân sự",
    Dia_diem_ky: "Đà Lạt",
    Ngay_ky_day: "01",
    Ngay_ky_month: "09",
    Ngay_ky_year: "2026",
    Nam_thue: "2026",
    Code: "APP001928",
    Email: "nguyenvanan.example@mail.com",
    So_dinh_danh_cu: "",
    Ten_truong: "Trường Cao đẳng Đà Lạt",
    So_tai_khoan: "0123456789012",
    Ten_ngan_hang: "Vietcombank chi nhánh Lâm Đồng",
  });
  for (const key of CHECKBOX_PLACEHOLDERS) values[key] = "☐";
  values.Tien_an_tien_su_Khong = "☒";
  values.Da_tung_lam_DHF_Khong = "☒";
  values.Cong_viec_hien_tai_Sinh_vien = "☒";
  values.TKNH_Da_co = "☒";
  values.Thu_nhap_Chi_DHF = "☒";
  values.Tap_nghe_Trong_cham_soc_thu_hoach = "☒";
  return values;
}

test("canonical trainee-registration HTML → Playwright PDF: page count follows the published canonical body", { skip: !chromiumAvailable }, async () => {
  const values = canonicalFieldValues();
  // Body/CSS come from the canonical DB version payload — never from a static
  // TypeScript module. Expected page count is DERIVED from that same body.
  const manifest = readCanonicalManifest();
  const canonical = readCanonicalVersionParts();
  const expectedPages = manifest.logicalPageCount;
  const { html, unreplaced } = renderApplicantHtmlFromParts(
    canonical.htmlBody,
    canonical.printCss,
    values,
  );
  assert.deepEqual(unreplaced, []);

  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(async () => document.fonts.ready);

    const browserChecks = await page.evaluate(() => {
      const pages = Array.from(document.querySelectorAll<HTMLElement>(".page"));
      const mergeValues = Array.from(document.querySelectorAll<HTMLElement>(".merge-value"));
      return {
        logicalPages: pages.length,
        previewUi: document.querySelectorAll(".toolbar, .nav-tabs, .code-panel, .page-label, button, script").length,
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        mergeValuesFit: mergeValues.every((value) => value.getBoundingClientRect().right <= value.parentElement!.getBoundingClientRect().right + 1),
        checkboxes: document.querySelectorAll(".chk").length,
      };
    });
    assert.equal(browserChecks.logicalPages, expectedPages);
    assert.equal(browserChecks.previewUi, 0);
    assert.ok(browserChecks.horizontalOverflow <= 1, `horizontal overflow: ${browserChecks.horizontalOverflow}px`);
    assert.equal(browserChecks.mergeValuesFit, true, "long Vietnamese merge text must wrap inside its containing line");
    assert.equal(browserChecks.checkboxes, CHECKBOX_PLACEHOLDERS.length);

    const bytes = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    const pdf = await PDFDocument.load(bytes);
    assert.equal(
      pdf.getPageCount(),
      expectedPages,
      "rendered page count must equal the canonical body's own section count — never a hard-coded number",
    );
    for (const pdfPage of pdf.getPages()) {
      assert.ok(Math.abs(pdfPage.getWidth() - 595.28) < 1, `A4 width: ${pdfPage.getWidth()}`);
      assert.ok(Math.abs(pdfPage.getHeight() - 841.89) < 1, `A4 height: ${pdfPage.getHeight()}`);
    }
  } finally {
    await browser.close();
  }
});
