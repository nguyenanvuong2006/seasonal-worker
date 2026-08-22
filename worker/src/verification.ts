/**
 * Document Merge — cloud verification helpers (worker endpoints).
 *
 * 1. renderPdfPagesToPng  — pdfjs-dist + @napi-rs/canvas: render từng trang PDF → PNG.
 * 2. comparePdfs          — page count + pixel diff (pixelmatch) + warnings.
 * 3. SAMPLE_FIELD_VALUES  — dữ liệu mẫu deterministic (KHÔNG dùng dữ liệu production).
 *
 * CHẠY TRÊN CLOUD RUN (Chromium/Playwright có sẵn) — user không cần máy.
 */

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import pixelmatch from "pixelmatch";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// pdfjs trong Node: trỏ workerSrc tới pdf.worker.mjs thật (fake worker không đủ).
const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
).href;

/** Dữ liệu mẫu deterministic — 1 ứng viên (không phải dữ liệu thật). */
export const SAMPLE_FIELD_VALUES: Record<string, string> = {
  Ho_ten: "Nguyễn Văn An",
  Ngay_sinh: "15/03/2001",
  So_CCCD: "072201012345",
  Ngay_cap_CCCD: "10/01/2022",
  Noi_cap_CCCD: "Cục CSDL quốc gia về dân cư",
  So_dien_thoai: "0912345678",
  Email: "nguyenvanan.example@mail.com",
  Dia_chi_thuong_tru: "Số 12, đường Trần Phú, phường 3, TP Đà Lạt, Lâm Đồng",
  Dia_chi_tam_tru: "Số 12, đường Trần Phú, phường 3, TP Đà Lạt, Lâm Đồng",
  dia_chi_cu_tru: "Số 12, đường Trần Phú, phường 3, TP Đà Lạt, Lâm Đồng",
  So_dinh_danh_cu: "",
  Tien_an_tien_su_Co: "",
  Tien_an_tien_su_Khong: "X",
  Da_tung_lam_DHF_Co: "",
  Da_tung_lam_DHF_Khong: "X",
  Loai_cong_viec_Nhan_vien: "X",
  Loai_cong_viec_Cong_nhan: "",
  Loai_cong_viec_Lao_dong_tap_nghe: "",
  Khu_vuc_Da_Lat: "X",
  Khu_vuc_Da_Quy: "",
  Khu_vuc_Da_Ron: "",
  Khu_vuc_Lam_Ha: "",
  Khu_vuc_Khac: "",
  Cong_viec_hien_tai_Sinh_vien: "X",
  Cong_viec_hien_tai_Khac: "",
  Cong_viec_hien_tai_khac: "",
  Ten_truong: "Trường Cao đẳng Đà Lạt",
  TKNH_Da_co: "X",
  TKNH_Chua_co: "",
  So_tai_khoan: "0123456789012",
  Ten_ngan_hang: "Vietcombank chi nhánh Lâm Đồng",
  Nam_thue: "2026",
  Thu_nhap_Chi_DHF: "X",
  Thu_nhap_Ngoai_DHF: "",
  Cong_ty_thu_nhap_khac: "",
  Dia_diem_thu_nhap_khac: "",
  Tap_nghe_Trong_cham_soc_thu_hoach: "X",
  Tap_nghe_Ban_hang: "",
  Tap_nghe_Dong_goi: "",
  Tap_nghe_Khac: "",
  Cong_viec_khac: "",
  Ngay_nhan_viec: "01/09/2026",
  Nguoi_tiep_nhan: "Phòng Hành chính – Nhân sự",
  Ngay_tiep_nhan: "17/08/2026",
  Dia_diem_ky: "Đà Lạt",
  Ngay_ky_day: "17",
  Ngay_ky_month: "08",
  Ngay_ky_year: "2026",
  Code: "APP001928",
};

/** Render tất cả trang PDF → PNG buffers (scale 1.0 ≈ 595×842 cho A4). */
export async function renderPdfPagesToPng(pdfBytes: Uint8Array, scale = 1.0): Promise<Buffer[]> {
  const doc = await getDocument({ data: pdfBytes }).promise;
  const pages: Buffer[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
      pages.push(canvas.toBuffer("image/png"));
    }
  } finally {
    const d = doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    try {
      await d.destroy?.();
    } catch {
      await d.cleanup?.();
    }
  }
  return pages;
}

export interface VisualDiffPage {
  page: number;
  diffPixels: number;
  diffPercent: number;
}

export interface VisualVerifyReport {
  referencePages: number;
  renderedPages: number;
  pageCountMatch: boolean;
  pageBreakDifference: boolean;
  diff: VisualDiffPage[];
  /** % khác biệt trung bình (chỉ khi cùng số trang). */
  avgDiffPercent: number | null;
  warnings: string[];
  pass: boolean;
}

/**
 * So sánh reference PDF (Google Docs export) với rendered PDF (HTML engine).
 * - Khác số trang → FAIL (pageBreakDifference=true) — spec: 6 vs 5 = FAIL.
 * - Cùng số trang → pixel diff từng trang (pixelmatch, threshold 0.1).
 * - Chấp nhận sai khác render nhỏ (≤3%/trang); KHÔNG chấp nhận khác pagination.
 */
export async function comparePdfs(
  referencePdf: Uint8Array,
  renderedPdf: Uint8Array,
  opts: { scale?: number } = {},
): Promise<VisualVerifyReport> {
  const scale = opts.scale ?? 1.0;
  // pdfjs từ chối Buffer (dù Buffer là subclass Uint8Array) — copy sang Uint8Array thuần.
  const refBytes = new Uint8Array(referencePdf);
  const rendBytes = new Uint8Array(renderedPdf);
  const [refPngs, rendPngs] = await Promise.all([
    renderPdfPagesToPng(refBytes, scale),
    renderPdfPagesToPng(rendBytes, scale),
  ]);

  const warnings: string[] = [];
  const pageCountMatch = refPngs.length === rendPngs.length;
  if (!pageCountMatch) {
    warnings.push(
      `Số trang KHÁC NHAU: reference=${refPngs.length}, rendered=${rendPngs.length} — pagination FAIL.`,
    );
  }

  const diff: VisualDiffPage[] = [];
  const compareCount = Math.min(refPngs.length, rendPngs.length);
  for (let i = 0; i < compareCount; i++) {
    const imgA = await loadImage(refPngs[i]);
    const imgB = await loadImage(rendPngs[i]);
    const w = Math.min(imgA.width, imgB.width);
    const h = Math.min(imgA.height, imgB.height);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgA, 0, 0, w, h);
    const rawA = ctx.getImageData(0, 0, w, h).data;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(imgB, 0, 0, w, h);
    const rawB = ctx.getImageData(0, 0, w, h).data;
    const out = Buffer.alloc(w * h * 4);
    const diffPixels = pixelmatch(rawA, rawB, out, w, h, { threshold: 0.1, includeAA: false });
    const diffPercent = Math.round((diffPixels / (w * h)) * 10000) / 100;
    diff.push({ page: i + 1, diffPixels, diffPercent });
  }

  const avgDiffPercent =
    diff.length > 0
      ? Math.round((diff.reduce((s, d) => s + d.diffPercent, 0) / diff.length) * 100) / 100
      : null;

  const pass = pageCountMatch && diff.every((d) => d.diffPercent <= 3);
  if (!pass && pageCountMatch) {
    const worst = diff.reduce((m, d) => (d.diffPercent > m.diffPercent ? d : m), diff[0]);
    warnings.push(`Trang ${worst.page} khác biệt ${worst.diffPercent}% (ngưỡng 3%).`);
  }

  return {
    referencePages: refPngs.length,
    renderedPages: rendPngs.length,
    pageCountMatch,
    pageBreakDifference: !pageCountMatch,
    diff,
    avgDiffPercent,
    warnings,
    pass,
  };
}
