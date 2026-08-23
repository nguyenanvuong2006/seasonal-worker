/**
 * Tạo sample HTML (đã fill dữ liệu mẫu) cho visual verification.
 *
 * Chạy: cd worker && npm run generate:sample
 * Output: docs/visual-verification/dang-ky-tap-nghe-sample.html
 *
 * Mở file trong trình duyệt → Print → Save as PDF → so sánh với PDF
 * export từ Google Docs gốc (reference). KHÔNG fake — đây là bản render
 * thật từ ĐÚNG template.ts + ĐÚNG renderer production (html-renderer).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dangKyTapNgheTemplate } from "../../src/document-templates/dang-ky-tap-nghe/template.ts";
import { renderApplicantHtmlFromParts } from "../../src/lib/document-merge/html-renderer.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Dữ liệu mẫu deterministic — 1 ứng viên (không phải dữ liệu thật). */
export const SAMPLE_FIELD_VALUES = {
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
  // Checkbox: giá trị "X" = được chọn, "" = bỏ trống (checkbox-engine ☒/☐)
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

const { html } = renderApplicantHtmlFromParts(
  dangKyTapNgheTemplate.html,
  dangKyTapNgheTemplate.css,
  SAMPLE_FIELD_VALUES,
);

const outDir = join(ROOT, "docs", "visual-verification");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "dang-ky-tap-nghe-sample.html");
writeFileSync(outFile, html, "utf8");

const unreplaced = [...html.matchAll(/(?:<<\s*([^>]+?)\s*>>|\{\{\s*([^{}]+?)\s*\}\})/g)].map((m) => m[1] ?? m[2]);
console.log(`✅ Sample HTML: ${outFile}`);
console.log(`   Template: ${dangKyTapNgheTemplate.name}`);
console.log(`   Placeholder chưa fill: ${unreplaced.length > 0 ? unreplaced.join(", ") : "KHÔNG (tất cả đã fill)"}`);
console.log("   Mở file trong trình duyệt → Print (A4, margins default) → Save as PDF → so với reference.");
