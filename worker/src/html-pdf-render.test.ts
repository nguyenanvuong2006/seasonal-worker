/**
 * Integration check for the same Playwright/Chromium PDF stack deployed by the
 * worker. It is skipped only on machines where Playwright's browser binary was
 * not installed; Cloud Run's Playwright image always runs it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import { renderApplicantHtmlFromParts } from "../../src/lib/document-merge/html-renderer.ts";

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
