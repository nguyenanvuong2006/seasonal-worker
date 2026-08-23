#!/usr/bin/env node
/**
 * VISUAL VERIFICATION HARNESS — Document Merge HTML/PDF engine (Phase 5).
 *
 * Render template HTML → PDF (Playwright/Chromium) + chạy các kiểm tra cấu trúc:
 *   - số trang A4 thật trong PDF
 *   - đúng số logical `.page`
 *   - không còn placeholder <<...>> / {{...}} chưa fill
 *   - không overflow ngang
 *   - không overflow dọc trong từng logical A4 page
 *   - không blank page bất ngờ
 *   - font chờ sẵn sàng
 *   - screenshot từng logical page theo đúng print media
 *
 * Chạy ở nơi có Chromium (CI / máy dev / Cloud Run image):
 *   cd worker && npm run generate:sample
 *   npm run verify:visual -- --html ../artifacts/document-merge/trainee-registration/rendered-sample.html --expected-pages 6 --out ../artifacts/document-merge/trainee-registration/browser-evidence
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

  // IMPORTANT: all geometry checks and screenshots must use the same print CSS
  // that page.pdf() uses. Previously these checks ran in screen media, so the
  // harness could miss print-only pagination defects.
  await page.emulateMedia({ media: "print" });

  const checks = await page.evaluate(() => {
    const pageDivs = Array.from(document.querySelectorAll(".page"));
    const pageCount = pageDivs.length;
    const blankPages = pageDivs
      .map((div, i) => ({ i: i + 1, textLen: (div.textContent || "").trim().length }))
      .filter((p) => p.textLen < 10);

    const pageGeometry = pageDivs.map((div, i) => {
      const rect = div.getBoundingClientRect();
      const verticalOverflowPx = Math.max(0, div.scrollHeight - div.clientHeight);
      return {
        page: i + 1,
        widthPx: Number(rect.width.toFixed(2)),
        heightPx: Number(rect.height.toFixed(2)),
        clientHeightPx: div.clientHeight,
        scrollHeightPx: div.scrollHeight,
        verticalOverflowPx,
      };
    });

    const verticalOverflows = pageGeometry.filter((p) => p.verticalOverflowPx > 1);
    const horizontalOverflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const checkboxes = document.querySelectorAll(".chk").length;
    const unreplaced = Array.from(document.querySelectorAll("body *"))
      .flatMap((el) => (el.childNodes.length === 1 && el.textContent ? [el.textContent] : []))
      .filter((t) => /(?:<<\s*[^>]+?\s*>>|\{\{\s*[^{}]+?\s*\}\})/.test(t));

    return {
      pageCount,
      blankPages,
      pageGeometry,
      verticalOverflows,
      horizontalOverflow,
      checkboxes,
      unreplaced,
    };
  });

  const pdfBytes = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  const pdfPath = join(outDir, "rendered.pdf");
  writeFileSync(pdfPath, pdfBytes);
  const pdfSha256 = createHash("sha256").update(pdfBytes).digest("hex");

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const realPageCount = pdfDoc.getPageCount();

  const fontChecks = await page.evaluate(() => {
    const probe = "Nguyễn Văn An — Đà Lạt, ngày 17 tháng 08 năm 2026";
    return {
      dejavu: document.fonts.check('12pt "DejaVu Sans"', probe),
      serif: document.fonts.check('12pt "DejaVu Serif"', probe),
    };
  });

  // Screenshot every logical A4 page in print media. locator.screenshot()
  // handles scrolling and avoids fragile document-coordinate clipping.
  const pageLocators = page.locator(".page");
  const logicalPageCount = await pageLocators.count();
  const screenshotPaths = [];

  for (let index = 0; index < logicalPageCount; index += 1) {
    const filename = `page-${String(index + 1).padStart(2, "0")}.png`;
    const screenshotPath = join(outDir, filename);
    const pageLocator = pageLocators.nth(index);
    await pageLocator.scrollIntoViewIfNeeded();
    await pageLocator.screenshot({ path: screenshotPath, animations: "disabled" });
    screenshotPaths.push(screenshotPath);
  }

  const fullScreenshotPath = join(outDir, "full.png");
  await page.screenshot({ path: fullScreenshotPath, fullPage: true });

  const paginationWarnings = [
    ...(expectedPages !== null && realPageCount !== expectedPages
      ? [`PDF page count ${realPageCount} differs from expected ${expectedPages}`]
      : []),
    ...(expectedPages !== null && checks.pageCount !== expectedPages
      ? [`logical page count ${checks.pageCount} differs from expected ${expectedPages}`]
      : []),
    ...checks.blankPages.map((blank) => `logical page ${blank.i} appears blank (${blank.textLen} characters)`),
    ...checks.verticalOverflows.map(
      (item) => `logical page ${item.page} vertical overflow ${item.verticalOverflowPx}px (scrollHeight=${item.scrollHeightPx}, clientHeight=${item.clientHeightPx})`,
    ),
    ...(checks.horizontalOverflow > 1 ? [`horizontal overflow ${checks.horizontalOverflow}px`] : []),
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
      pageGeometry: checks.pageGeometry,
      verticalOverflows: checks.verticalOverflows,
      horizontalOverflowPx: checks.horizontalOverflow,
      checkboxCount: checks.checkboxes,
      unresolvedPlaceholderCount: checks.unreplaced.length,
      unreplacedPlaceholders: checks.unreplaced,
      paginationWarnings,
      fontsReady: true,
      fontChecks,
    },
    pass:
      (expectedPages === null || realPageCount === expectedPages) &&
      (expectedPages === null || checks.pageCount === expectedPages) &&
      checks.blankPages.length === 0 &&
      checks.verticalOverflows.length === 0 &&
      checks.horizontalOverflow <= 1 &&
      checks.unreplaced.length === 0,
  };

  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify(report, null, 2));
  console.log(report.pass ? "\n✅ VISUAL CHECK PASS" : "\n❌ VISUAL CHECK FAIL");
} finally {
  await browser.close();
}
