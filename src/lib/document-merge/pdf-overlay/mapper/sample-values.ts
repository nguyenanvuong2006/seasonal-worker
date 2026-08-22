/**
 * PDF Overlay — Visual Mapper sample values (PR3, preview mode).
 *
 * Dữ liệu MẪU in-memory dùng cho PREVIEW an toàn — KHÔNG đọc Production candidate,
 * KHÔNG tạo merge job, KHÔNG mutate Production. Preview dùng chính các giá trị này
 * để minh hoạ layout với: tiếng Việt, ngày tháng, địa chỉ dài, checkbox, multiline.
 *
 * Module THUẦN, dùng chung cho preview + test.
 */

export interface SampleValueSet {
  values: Record<string, string>;
  /** Danh sách placeholder mà preview nên chứng minh (tiếng Việt, date, ...). */
  highlighted: string[];
}

/** Giá trị mẫu cho preview — có thể merge với giá trị admin nhập tay. */
export const DEFAULT_SAMPLE_VALUES: Record<string, string> = {
  Ho_ten: "Bùi Nguyễn Phương Vy",
  Ngay_sinh: "15/08/2003",
  Ngay_cap: "12/03/2021",
  So_CCCD: "082203001234",
  Gioi_tinh: "Nữ",
  Dan_toc: "Kinh",
  Ton_giao: "Không",
  So_dien_thoai: "0912 345 678",
  Email: "phuongvy.bui@example.com",
  Dia_chi_thuong_tru: "Số 12/7 Đường Nguyễn Tử Lực, Phường Bảo Lộc, Thành phố Đà Lạt, Tỉnh Lâm Đồng, Việt Nam",
  Dia_chi_lien_he: "Số 12/7 Đường Nguyễn Tử Lực, Đà Lạt, Lâm Đồng",
  Ngay_bat_dau: "01/09/2026",
  Ngay_ket_thuc: "31/12/2026",
  Loai_cong_viec: "Chăm sóc và thu hoạch rau, hoa công nghệ cao tại Đà Lạt",
  Don_vi_tiep_nhan: "Nông trại Hoa Vàng — Đà Lạt, Lâm Đồng",
  Muc_luong: "6.500.000 đồng",
  Ho_ten_nguoi_lao_dong: "Bùi Nguyễn Phương Vy",
  So_hop_dong_dich_vu_thue: "HĐ/2026/ĐL-0187",
  Ngay_hop_dong_dich_vu_thue: "20/08/2026",
  Cam_ket: "Tôi xin cam kết chấp hành nghiêm chỉnh các quy định, nội quy, quy chế của cơ quan, đơn vị tiếp nhận và các quy định pháp luật hiện hành của nước Cộng hòa xã hội chủ nghĩa Việt Nam.",
};

/**
 * Định nghĩa một số placeholder checkbox → dùng chung cho preview + test.
 * source_key quyết định trạng thái (isCheckboxMatch), option_value chọn option.
 */
export const SAMPLE_CHECKBOX_OPTIONS: Array<{ placeholder: string; sourceKey: string; optionValue: string }> = [
  { placeholder: "Khu_vuc", sourceKey: "Khu_vuc", optionValue: "Đà Lạt" },
  { placeholder: "Tap_nghe", sourceKey: "Tap_nghe", optionValue: "Được" },
  { placeholder: "Tien_an_tien_su", sourceKey: "Tien_an_tien_su", optionValue: "Có" },
];

/** Những placeholder highlight trong preview (minh hoạ yêu cầu H). */
export const HIGHLIGHTED_PREVIEW_KEYS = [
  "Ho_ten",
  "Ngay_bat_dau",
  "Dia_chi_thuong_tru",
  "Cam_ket",
];

/** Trả giá trị mẫu cho placeholder (fallback: chuỗi placeholder). */
export function sampleValueFor(placeholder: string): string {
  return DEFAULT_SAMPLE_VALUES[placeholder] ?? `[${placeholder}]`;
}

/** Build một SampleValueSet từ giá trị mặc định + overrides (admin nhập tay). */
export function buildSampleValueSet(overrides: Record<string, string> = {}): SampleValueSet {
  return {
    values: { ...DEFAULT_SAMPLE_VALUES, ...overrides },
    highlighted: HIGHLIGHTED_PREVIEW_KEYS,
  };
}
