"use client";
/**
 * pdf.js loader cho Visual Mapper (PR3). Chỉ load ở client (browser) — dùng
 * dynamic import để tránh lỗi DOMMatrix khi SSR/static build ở Node. Worker được
 * trỏ tới bundle worker cục bộ (webpack/Turbopack `?url` → URL string).
 */

type PdfJsModule = typeof import("pdfjs-dist");

let cached: Promise<PdfJsModule> | null = null;

export function getPdfJs(): Promise<PdfJsModule> {
  if (!cached) {
    cached = (async () => {
      const mod = await import("pdfjs-dist");
      // Worker pdf.js đặt tại public/ (copied from node_modules/pdfjs-dist/build)
      // — đáng tin cậy hơn `?url` (không emit asset khi build).
      mod.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return mod;
    })();
  }
  return cached;
}
