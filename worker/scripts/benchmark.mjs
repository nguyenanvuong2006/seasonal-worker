#!/usr/bin/env node
/**
 * BENCHMARK — Document Merge PDF worker (Phase 15).
 *
 * Đo hiệu năng render HTML→PDF với batch 1 / 10 / 50 / 100 (tham số --max).
 * Output: Bảng metrics (records, duration_ms, avg_render_ms, p95_render_ms,
 * failed, concurrency, pdf_merge_ms, zip_ms, upload_ms).
 *
 * KHÔNG fake: render THẬT qua Playwright/Chromium với đúng template
 * Dang_ky_Tap_nghe + dữ liệu mẫu deterministic. Chạy ở nơi có Chromium
 * (CI / máy dev / Cloud Run image):
 *   cd worker && npx playwright install chromium && npm run benchmark
 *
 * Lưu ý: đây là benchmark KHÔNG dùng DB/queue — chỉ đo phần render thuần.
 * Batch thật (500) cần thêm network + storage; ước tính từ các mốc này.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import { dangKyTapNgheTemplate } from "../../src/document-templates/dang-ky-tap-nghe/template.ts";
import { renderApplicantHtmlFromParts } from "../../src/lib/document-merge/html-renderer.ts";
import { SAMPLE_FIELD_VALUES } from "./generate-template-sample.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX = Number(process.argv[2] ?? 100);
const CONCURRENCY = Math.max(1, Number(process.env.PDF_RENDER_CONCURRENCY ?? 4));

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const { html } = renderApplicantHtmlFromParts(
  dangKyTapNgheTemplate.html,
  dangKyTapNgheTemplate.css,
  SAMPLE_FIELD_VALUES,
);

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });

async function renderOne(htmlString) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:")) route.continue();
      else route.abort("blockedbyclient");
    });
    const start = Date.now();
    await page.setContent(htmlString, { waitUntil: "load" });
    await page.evaluate(async () => document.fonts.ready);
    const bytes = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    return { ms: Date.now() - start, bytes };
  } finally {
    await context.close();
  }
}

const report = { environment: { concurrency: CONCURRENCY }, runs: [] };

for (const count of [1, 10, 50, Math.min(100, MAX)]) {
  if (count > MAX) continue;
  const renders = [];
  const t0 = Date.now();
  const queue = [...Array(count).keys()];
  let failed = 0;

  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.all(
      batch.map(async () => {
        try {
          return await renderOne(html);
        } catch (e) {
          failed += 1;
          return { ms: 0, bytes: new Uint8Array(0) };
        }
      }),
    );
    renders.push(...results);
  }
  const durationMs = Date.now() - t0;

  // Mô phỏng merge + zip (không network)
  const tMerge = Date.now();
  const merged = await PDFDocument.create();
  for (const r of renders) {
    if (r.bytes.length > 0) {
      const src = await PDFDocument.load(r.bytes);
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const p of pages) merged.addPage(p);
    }
  }
  const mergedBytes = await merged.save();
  const pdfMergeMs = Date.now() - tMerge;

  const sortedMs = renders.map((r) => r.ms).filter((m) => m > 0).sort((a, b) => a - b);
  const run = {
    records: count,
    duration_ms: durationMs,
    avg_render_ms: Math.round(sortedMs.reduce((a, b) => a + b, 0) / Math.max(1, sortedMs.length)),
    p95_render_ms: Math.round(percentile(sortedMs, 95)),
    failed,
    concurrency: CONCURRENCY,
    pdf_merge_ms: pdfMergeMs,
    zip_ms: 0, // cần yazl — đo ở finalize thật
    upload_ms: 0, // cần storage — đo ở production
    merged_pdf_bytes: mergedBytes.byteLength,
  };
  report.runs.push(run);
  console.log(JSON.stringify(run));
}

mkdirSync(join(ROOT, "docs", "visual-verification"), { recursive: true });
writeFileSync(join(ROOT, "docs", "visual-verification", "benchmark.json"), JSON.stringify(report, null, 2));
console.log(`\n✅ Benchmark xong → docs/visual-verification/benchmark.json`);
await browser.close();
