/**
 * REGRESSION — signature/acknowledgement .sign-block must never be split
 * across a physical PDF page boundary (production defect, 2026-09).
 *
 * Root cause: the shared renderer's break-inside protection (A4_PRINT_CSS in
 * html-renderer.ts) targeted `.sig-block`, but every real template —
 * including the currently PUBLISHED trainee-registration v18 — uses
 * `.sign-block` for its signature container. The rule never matched
 * anything, so a signature block landing close to the bottom margin could
 * be split: e.g. "ky ten xac nhan hieu ro cac khoan neu tren" ending one
 * page, "va cam ket tuan thu nghiem tuc" + the candidate name orphaned onto
 * a near-empty next page — exactly what was observed in a real Production
 * HTML_PDF merge.
 *
 * These tests render REAL Chromium PDF output (same stack as the worker)
 * and inspect physical page placement via pdfjs-dist text extraction —
 * assertions on rendered CSS strings alone would not catch a class-name
 * mismatch like this one. Skips only when the exact Playwright/Chromium
 * revision this repo pins is unavailable; Cloud Run's Playwright image
 * (worker/Dockerfile) always has it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { renderApplicantHtmlFromParts } from "../../src/lib/document-merge/html-renderer.ts";

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
).href;

const executablePath = chromium.executablePath();
const chromiumAvailable = existsSync(executablePath);

/** Real text lines from the PUBLISHED v18 signature/acknowledgement block
 * (templates/document-merge/trainee-registration/canonical-source.v12.html),
 * copied verbatim so this test reproduces the exact reported failure. */
const SIGN_LINES = [
  "Người đăng ký tham gia tập nghề",
  "ký tên xác nhận hiểu rõ các khoản nêu trên",
  "và cam kết tuân thủ nghiêm túc",
];
const CANDIDATE_NAME = "Bùi Nguyễn Phương Vy";

/** Filler count calibrated empirically to land the block right at the page-1/
 * page-2 boundary — the exact condition where an unprotected block splits. */
const CALIBRATED_FILLER_COUNT = 44;

function buildSignatureBlockBody(fillerParagraphs: number): string {
  const filler = Array.from(
    { length: fillerParagraphs },
    (_, i) =>
      `<div class="line justify">Đoạn nội dung thử nghiệm số ${i + 1} để lấp đầy trang, mô phỏng nội dung quy định tập nghề thực tế có độ dài tương đương.</div>`,
  ).join("\n");
  return `
<div class="page"><div class="paper">
${filler}
  <div class="sign-block mt-8">
    <div>${SIGN_LINES[0]}</div>
    <div>${SIGN_LINES[1]}</div>
    <div>${SIGN_LINES[2]}</div>
    <div style="height:24mm"></div>
    <div class="b">{{Ho_ten}}</div>
  </div>
</div></div>`;
}

/** Renders `html` and returns each physical page's extracted text. */
async function renderAndExtractPageTexts(html: string): Promise<{ pageCount: number; texts: string[] }> {
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(async () => {
      await (document as Document & { fonts: FontFaceSet }).fonts.ready;
    });
    const bytes = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    const pdf = await PDFDocument.load(bytes);
    // pdfjs-dist rejects Buffer (even though it's a Uint8Array subclass) —
    // copy to a plain Uint8Array first (same pattern as worker/src/verification.ts).
    const doc = await getDocument({ data: Uint8Array.from(bytes) }).promise;
    const texts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pdfPage = await doc.getPage(i);
      const content = await pdfPage.getTextContent();
      texts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    const d = doc as unknown as { destroy?: () => Promise<void> };
    await d.destroy?.();
    return { pageCount: pdf.getPageCount(), texts };
  } finally {
    await browser.close();
  }
}

function pageIndexContaining(texts: string[], needle: string): number {
  return texts.findIndex((t) => t.includes(needle));
}

test(
  "signature/acknowledgement .sign-block stays on ONE physical PDF page when positioned close enough to the bottom margin to previously split",
  { skip: !chromiumAvailable },
  async () => {
    const { html } = renderApplicantHtmlFromParts(buildSignatureBlockBody(CALIBRATED_FILLER_COUNT), "", {
      Ho_ten: CANDIDATE_NAME,
    });
    const { pageCount, texts } = await renderAndExtractPageTexts(html);
    assert.ok(pageCount >= 2, "calibration must actually approach a page boundary");

    const linePages = SIGN_LINES.map((line) => pageIndexContaining(texts, line.slice(0, 12)));
    const namePage = pageIndexContaining(texts, CANDIDATE_NAME);

    assert.ok(linePages.every((p) => p >= 0), "every sign-block line must be found somewhere in the PDF");
    assert.ok(namePage >= 0, "the candidate name must be found somewhere in the PDF");

    const pagesInvolved = new Set([...linePages, namePage]);
    assert.equal(
      pagesInvolved.size,
      1,
      `the entire .sign-block (lines + name) must land on exactly one physical page; found pages ${JSON.stringify([...pagesInvolved])} — a near-empty trailing page containing only the name is exactly the reported production defect`,
    );

    // The block must not be clipped/duplicated either — every line and the
    // name appear exactly once across all pages.
    for (const line of SIGN_LINES) {
      const occurrences = texts.filter((t) => t.includes(line.slice(0, 12))).length;
      assert.equal(occurrences, 1, `"${line}" must appear on exactly one page (no duplication/clipping)`);
    }
  },
);

test(
  "COUNTERFACTUAL: without .sign-block break-inside protection, the identical calibrated content DOES split — proving the fix is necessary, not incidental",
  { skip: !chromiumAvailable },
  async () => {
    // Overrides the shared renderer's protection for this one class, exactly
    // simulating the pre-fix state (the class-name mismatch meant `.sign-block`
    // effectively had no break-inside rule in production).
    const disableProtectionCss = ".sign-block { break-inside: auto; page-break-inside: auto; }";
    const { html } = renderApplicantHtmlFromParts(
      buildSignatureBlockBody(CALIBRATED_FILLER_COUNT),
      disableProtectionCss,
      { Ho_ten: CANDIDATE_NAME },
    );
    const { texts } = await renderAndExtractPageTexts(html);

    const linePages = SIGN_LINES.map((line) => pageIndexContaining(texts, line.slice(0, 12)));
    const namePage = pageIndexContaining(texts, CANDIDATE_NAME);
    const pagesInvolved = new Set([...linePages, namePage]);

    assert.ok(
      pagesInvolved.size > 1,
      "expected the unprotected block to split across pages at this calibrated filler count — if this fails, recalibrate CALIBRATED_FILLER_COUNT so the positive test above stays meaningful",
    );
  },
);
