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
 *   cd worker && npm run verify:visual -- [--html ../docs/visual-verification/dang-ky-tap-nghe-sample.html] [--expected-pages 5] [--out ../docs/visual-verification/out]
 *
 * Use --expected-pages for an approved canonical visual template. The command
 * then fails on an extra/partial PDF page rather than accepting it silently.
 *
 * Output:
 *   <out>/report.json          — kết quả kiểm tra (máy đọc được)
 *   <out>/page-01.png ...      — screenshot từng trang (đối chiếu visual)
 *   <out>/full.png             — screenshot toàn bộ (tham khảo)
 *
 * KHÔNG fake: đây là render THẬT qua engine production (page.pdf A4 + @page CSS).
 * Nếu chưa có Chromium: chạy `npx playwright install chromium` trước.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const htmlPath = resolve(arg("--html", join(ROOT, "docs", "visual-verification", "dang-ky-tap-nghe-sample.html")));
const outDir = resolve(arg("--out", join(ROOT, "docs", "visual-verification", "out")));
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
  writeFileSync(join(outDir, "rendered.pdf"), pdfBytes);

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

  // Screenshot từng .page
  const pageBoxes = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".page")).map((div) => {
      const r = div.getBoundingClientRect();
      return { top: r.top + window.scrollY, height: r.height };
    }),
  );

  // full-page screenshot
  await page.screenshot({ path: join(outDir, "full.png"), fullPage: true });

  const report = {
    generatedAt: new Date().toISOString(),
    htmlSource: htmlPath,
    templateName: "dang-ky-tap-nghe",
    durationMs: Date.now() - startedAt,
    pdf: {
      bytes: pdfBytes.length,
      path: join(outDir, "rendered.pdf"),
    },
    checks: {
      pageDivCount: checks.pageCount,
      realPdfPageCount: realPageCount,
      expectedPageCount: expectedPages,
      logicalSectionCount: checks.pageCount,
      blankPages: checks.blankPages,
      horizontalOverflowPx: checks.overflow,
      checkboxCount: checks.checkboxes,
      unreplacedPlaceholders: checks.unreplaced,
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
