#!/usr/bin/env node
/**
 * VISUAL VERIFICATION HARNESS — Document Merge HTML/PDF engine (Phase 5).
 *
 * Render template HTML → PDF (Playwright/Chromium) + chạy các kiểm tra cấu trúc:
 *   - số trang A4 (theo .page trong HTML)
 *   - không còn placeholder <<...>> chưa fill
 *   - không overflow ngang (scrollWidth <= viewport)
 *   - không blank page bất ngờ (nội dung mỗi .page > 0)
 *   - font chờ sẵn sàng (fonts.ready)
 *   - số checkbox ☐ render được
 *
 * Chạy ở nơi có Chromium (CI / máy dev / Cloud Run image):
 *   cd worker && npm run generate:sample
 *   npm run verify:visual -- --html ../artifacts/document-merge/trainee-registration/rendered-sample.html --expected-pages 6 --out ../artifacts/document-merge/trainee-registration/browser-evidence
 *
 * Use --expected-pages for an approved canonical visual template. The command
 * fails on an extra/partial PDF page rather than accepting it silently.
 *
 * Output:
 *   <out>/report.json          — page count, SHA-256, browser revision, warnings
 *   <out>/rendered.pdf         — final Playwright PDF
 *   <out>/page-01.png ...      — screenshot of every logical page
 *   <out>/full.png             — full-document screenshot (reference)
 *
 * KHÔNG fake: đây là render THẬT qua engine production (page.pdf A4 + @page CSS).
 * Nếu chưa có Chromium: chạy `npx playwright install chromium` trước.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const playwrightVersion = require("playwright/package.json").version;

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const htmlPath = resolve(arg("--html", join(ROOT, "artifacts", "document-merge", "trainee-registration", "rendered-sample.html")));
const outDir = resolve(arg("--out", join(ROOT, "artifacts", "document-merge", "trainee-registration", "browser-evidence")));
const expectedPagesArg = arg("--expected-pages", "");
const expectedPages = expectedPagesArg === "" ? null : Number(expectedPagesArg);
if (expectedPages !== null && (!Number.isInteger(expectedPages) || expectedPages < 1)) {
  throw new Error("--expected-pages phải là số nguyên dương.");
}

const html = readFileSync(htmlPath, "utf8");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
});
const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
const page = await context.newPage();

const startedAt = Date.now();

try {
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  // --- Kiểm tra trong browser -------------------------------------------
  const checks = await page.evaluate(() => {
    const pageDivs = Array.from(document.querySelectorAll(".page"));
    const pageCount = pageDivs.length;
    const blankPages = pageDivs
      .map((div, i) => ({ i: i + 1, textLen: (div.textContent || "").trim().length }))
      .filter((p) => p.textLen < 10);
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const checkboxes = document.querySelectorAll(".chk").length;
    const unreplaced = Array.from(document.querySelectorAll("body *"))
      .flatMap((el) => (el.childNodes.length === 1 && el.textContent ? [el.textContent] : []))
      .filter((t) => /(?:<<\s*[^>]+?\s*>>|\{\{\s*[^{}]+?\s*\}\})/.test(t));
    return {
      pageCount,
      blankPages,
      overflow,
      checkboxes,
      unreplaced,
    };
  });

  const pdfBytes = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  const pdfPath = join(outDir, "rendered.pdf");
  writeFileSync(pdfPath, pdfBytes);
  const pdfSha256 = createHash("sha256").update(pdfBytes).digest("hex");

  // Đếm trang PDF THẬT (không dựa vào .page div) qua pdf-lib.
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const realPageCount = pdfDoc.getPageCount();

  // Xác nhận font render được tiếng Việt (DejaVu Sans có sẵn trong sandbox/Cloud Run image).
  const fontChecks = await page.evaluate(() => {
    const probe = "Nguyễn Văn An — Đà Lạt, ngày 17 tháng 08 năm 2026";
    return {
      dejavu: document.fonts.check('12pt "DejaVu Sans"', probe),
      serif: document.fonts.check('12pt "DejaVu Serif"', probe),
    };
  });

  // Screenshot every logical page using Playwright locators.
  // This avoids document-coordinate clip errors for pages below the viewport.
  const pageLocators = page.locator(".page");
  const logicalPageCount = await pageLocators.count();
  const screenshotPaths = [];

  for (let index = 0; index < logicalPageCount; index += 1) {
    const filename = `page-${String(index + 1).padStart(2, "0")}.png`;
    const screenshotPath = join(outDir, filename);
    const pageLocator = pageLocators.nth(index);

    await pageLocator.scrollIntoViewIfNeeded();
    await pageLocator.screenshot({
      path: screenshotPath,
      animations: "disabled",
    });

    screenshotPaths.push(screenshotPath);
  }

  // full-page screenshot
  const fullScreenshotPath = join(outDir, "full.png");
  await page.screenshot({ path: fullScreenshotPath, fullPage: true });

  const paginationWarnings = [
    ...(expectedPages !== null && realPageCount !== expectedPages
      ? [`PDF page count ${realPageCount} differs from expected ${expectedPages}`]
      : []),
    ...checks.blankPages.map((blank) => `logical page ${blank.i} appears blank (${blank.textLen} characters)`),
    ...(checks.overflow > 1 ? [`horizontal overflow ${checks.overflow}px`] : []),
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    htmlSource: htmlPath,
    htmlSha256: createHash("sha256").update(html).digest("hex"),
    templateName: "dang-ky-tap-nghe",
    durationMs: Date.now() - startedAt,
    browser: {
      chromium: browser.version(),
      playwright: playwrightVersion,
      node: process.version,
    },
    pdf: {
      bytes: pdfBytes.length,
      path: pdfPath,
      sha256: pdfSha256,
    },
    evidence: {
      screenshots: screenshotPaths,
      fullScreenshot: fullScreenshotPath,
    },
    checks: {
      pageDivCount: checks.pageCount,
      realPdfPageCount: realPageCount,
      expectedPageCount: expectedPages,
      logicalSectionCount: checks.pageCount,
      blankPages: checks.blankPages,
      horizontalOverflowPx: checks.overflow,
      checkboxCount: checks.checkboxes,
      unresolvedPlaceholderCount: checks.unreplaced.length,
      unreplacedPlaceholders: checks.unreplaced,
      paginationWarnings,
      fontsReady: true,
      fontChecks,
    },
    pass:
      (expectedPages === null || realPageCount === expectedPages) &&
      checks.blankPages.length === 0 &&
      checks.overflow <= 1 &&
      checks.unreplaced.length === 0,
  };

  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify(report, null, 2));
  console.log(report.pass ? "\n✅ VISUAL CHECK PASS" : "\n❌ VISUAL CHECK FAIL");
} finally {
  await browser.close();
}
