/**
 * Dang_ky_Tap_nghe_Template — schema tài liệu (tài liệu tham khảo).
 *
 * ⚠️ Đây CHỈ là tài liệu mô tả cấu trúc 5 phần + danh sách 49 canonical placeholder
 * active của template gốc. Source of truth cho MAPPING (placeholder → data)
 * nằm trong bảng merge_template_fields (Mapping Inspector), KHÔNG hardcode ở đây.
 *
 * Template HTML dùng các token semantic `{{...}}`; renderer vẫn hiểu `<<...>>`
 * của các phiên bản Google Docs cũ để không làm hỏng lịch sử.
 */

import type { TemplateContract } from "../../lib/document-merge/template-contract.ts";

export const GOOGLE_DOC_ID = "10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE";

/** 5 phần của bộ hồ sơ — tiêu đề khớp Google Doc golden source. */
export const SECTIONS = [
  { key: "dang_ky", title: "GIẤY ĐĂNG KÝ TẬP NGHỀ", page: 1 },
  { key: "quy_dinh", title: "QUY ĐỊNH VỀ TẬP NGHỀ", page: 2 },
  { key: "cam_ket_thue", title: "BẢN CAM KẾT", page: 3 },
  { key: "uy_quyen", title: "GIẤY ỦY QUYỀN", page: 4 },
  { key: "to_khai_thue", title: "TỜ KHAI ĐĂNG KÝ THUẾ", page: 5 },
] as const;

/**
 * 49 placeholder active — khớp Google Doc live / merge_template_fields
 * không orphan. Hai token hợp đồng dịch vụ thuế đã được operator chấp nhận
 * orphan và KHÔNG còn trong HTML canonical:
 *   So_hop_dong_dich_vu_thue, Ngay_hop_dong_dich_vu_thue
 */
export const REJECTED_ORPHAN_PLACEHOLDERS = [
  "So_hop_dong_dich_vu_thue",
  "Ngay_hop_dong_dich_vu_thue",
] as const;

export const PLACEHOLDERS = [
  // Thông tin cá nhân
  "Ho_ten", "Ngay_sinh", "Dia_chi_thuong_tru", "Dia_chi_tam_tru", "So_dien_thoai",
  "So_CCCD", "Ngay_cap_CCCD", "Noi_cap_CCCD", "dia_chi_cu_tru",
  // Checkbox tiền án tiền sự / từng làm DHF
  "Tien_an_tien_su_Khong", "Tien_an_tien_su_Co",
  "Da_tung_lam_DHF_Khong", "Da_tung_lam_DHF_Co",
  // Loại công việc trước đây
  "Loai_cong_viec_Nhan_vien", "Loai_cong_viec_Cong_nhan", "Loai_cong_viec_Lao_dong_tap_nghe",
  // Khu vực
  "Khu_vuc_Da_Lat", "Khu_vuc_Da_Quy", "Khu_vuc_Da_Ron", "Khu_vuc_Lam_Ha", "Khu_vuc_Khac",
  // Công việc hiện tại
  "Cong_viec_hien_tai_Sinh_vien", "Cong_viec_hien_tai_Khac", "Cong_viec_hien_tai_khac", "Ten_truong",
  // Tài khoản ngân hàng
  "TKNH_Da_co", "TKNH_Chua_co", "So_tai_khoan", "Ten_ngan_hang",
  // Thu nhập
  "Thu_nhap_Chi_DHF", "Thu_nhap_Ngoai_DHF", "Cong_ty_thu_nhap_khac", "Dia_diem_thu_nhap_khac",
  // Nguyện vọng tập nghề
  "Tap_nghe_Trong_cham_soc_thu_hoach", "Tap_nghe_Ban_hang", "Tap_nghe_Dong_goi", "Tap_nghe_Khac", "Cong_viec_khac",
  // Ngày / người tiếp nhận
  "Ngay_nhan_viec", "Ngay_tiep_nhan", "Nguoi_tiep_nhan", "Dia_diem_ky",
  "Ngay_ky_day", "Ngay_ky_month", "Ngay_ky_year",
  // Thuế / khác
  "Nam_thue", "Code", "Email", "So_dinh_danh_cu",
] as const;

/**
 * Canonical semantic field contract for the HTML template.  This is a
 * reviewable description of the normalized merge-data shape, not a second
 * resolver and not a set of sample applicant values.  The corresponding live
 * mappings are stored in merge_template_fields and snapshotted into each job.
 */
const checkboxField = (key: string, label: string, sourcePath: string, optionValue: string) => ({
  key,
  label,
  valueKind: "checkbox" as const,
  required: false,
  sourcePath,
  optionValue,
});

export const DANG_KY_TAP_NGHE_FIELD_CONTRACT: TemplateContract = {
  key: "dang-ky-tap-nghe",
  name: "Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế",
  logicalPageCount: 5,
  fields: [
    { key: "Ho_ten", label: "Họ và tên", valueKind: "text", required: true, sourcePath: "fullName" },
    { key: "Ngay_sinh", label: "Ngày sinh", valueKind: "date", required: true, sourcePath: "dob" },
    { key: "Dia_chi_thuong_tru", label: "Địa chỉ thường trú", valueKind: "text", required: true, sourcePath: "permanentAddress" },
    { key: "Dia_chi_tam_tru", label: "Địa chỉ tạm trú", valueKind: "text", required: true, sourcePath: "residentialAddress" },
    { key: "So_dien_thoai", label: "Số điện thoại", valueKind: "text", required: true, sourcePath: "phone" },
    { key: "So_CCCD", label: "Số CCCD", valueKind: "text", required: true, sourcePath: "cccd" },
    { key: "Ngay_cap_CCCD", label: "Ngày cấp CCCD", valueKind: "date", required: false, sourcePath: "dateOfIssue" },
    { key: "Noi_cap_CCCD", label: "Nơi cấp CCCD", valueKind: "text", required: false, sourcePath: "placeOfIssue" },
    { key: "dia_chi_cu_tru", label: "Địa chỉ cư trú", valueKind: "text", required: false, sourcePath: "permanentAddress" },

    checkboxField("Tien_an_tien_su_Khong", "Tiền án, tiền sự: Không", "customAnswers.tien_an_tien_su", "Không"),
    checkboxField("Tien_an_tien_su_Co", "Tiền án, tiền sự: Có", "customAnswers.tien_an_tien_su", "Có"),
    checkboxField("Da_tung_lam_DHF_Khong", "Đã từng làm DHF: Không", "declaredType", "NEW"),
    checkboxField("Da_tung_lam_DHF_Co", "Đã từng làm DHF: Có", "declaredType", "OLD"),
    checkboxField("Loai_cong_viec_Nhan_vien", "Loại công việc: Nhân viên", "customAnswers.loai_cong_viec_truoc_day", "Nhân viên"),
    checkboxField("Loai_cong_viec_Cong_nhan", "Loại công việc: Công nhân", "customAnswers.loai_cong_viec_truoc_day", "Công nhân"),
    checkboxField("Loai_cong_viec_Lao_dong_tap_nghe", "Loại công việc: Lao động tập nghề", "customAnswers.loai_cong_viec_truoc_day", "Lao động tập nghề"),
    checkboxField("Khu_vuc_Da_Lat", "Khu vực: Đà Lạt", "customAnswers.khu_vuc_lam_viec_truoc_day", "Đà Lạt"),
    checkboxField("Khu_vuc_Da_Quy", "Khu vực: Đa Quý", "customAnswers.khu_vuc_lam_viec_truoc_day", "Đa Quý"),
    checkboxField("Khu_vuc_Da_Ron", "Khu vực: Đạ Ròn", "customAnswers.khu_vuc_lam_viec_truoc_day", "Đạ Ròn"),
    checkboxField("Khu_vuc_Lam_Ha", "Khu vực: Lâm Hà", "customAnswers.khu_vuc_lam_viec_truoc_day", "Lâm Hà"),
    checkboxField("Khu_vuc_Khac", "Khu vực: Khác", "customAnswers.khu_vuc_lam_viec_truoc_day", "Khác"),
    checkboxField("Cong_viec_hien_tai_Sinh_vien", "Công việc hiện tại: Sinh viên", "customAnswers.cong_viec_hien_tai", "Sinh viên"),
    checkboxField("Cong_viec_hien_tai_Khac", "Công việc hiện tại: Khác", "customAnswers.cong_viec_hien_tai", "Khác"),
    { key: "Cong_viec_hien_tai_khac", label: "Công việc hiện tại khác", valueKind: "text", required: false, sourcePath: "customAnswers.cong_viec_hien_tai_khac" },
    { key: "Ten_truong", label: "Tên trường", valueKind: "text", required: false, sourcePath: "customAnswers.ten_truong" },
    checkboxField("TKNH_Da_co", "Tài khoản ngân hàng: Đã có", "customAnswers.tinh_trang_tknh", "Đã có"),
    checkboxField("TKNH_Chua_co", "Tài khoản ngân hàng: Chưa có", "customAnswers.tinh_trang_tknh", "Chưa có"),
    { key: "So_tai_khoan", label: "Số tài khoản", valueKind: "text", required: false, sourcePath: "customAnswers.so_tai_khoan" },
    { key: "Ten_ngan_hang", label: "Tên ngân hàng", valueKind: "text", required: false, sourcePath: "customAnswers.ten_ngan_hang" },
    checkboxField("Thu_nhap_Chi_DHF", "Nguồn thu nhập: Chỉ DHF", "customAnswers.nguon_thu_nhap", "Chỉ phát sinh tại Dalat Hasfarm"),
    checkboxField("Thu_nhap_Ngoai_DHF", "Nguồn thu nhập: Ngoài DHF", "customAnswers.nguon_thu_nhap", "Phát sinh ngoài Dalat Hasfarm"),
    { key: "Cong_ty_thu_nhap_khac", label: "Đơn vị thu nhập khác", valueKind: "text", required: false, sourcePath: "customAnswers.cong_ty_thu_nhap_khac" },
    { key: "Dia_diem_thu_nhap_khac", label: "Địa điểm thu nhập khác", valueKind: "text", required: false, sourcePath: "customAnswers.dia_diem_thu_nhap_khac" },
    checkboxField("Tap_nghe_Trong_cham_soc_thu_hoach", "Nguyện vọng: Trồng/chăm sóc/thu hoạch", "customAnswers.tap_nghe_nguyen_vong", "Trồng, chăm sóc, thu hoạch"),
    checkboxField("Tap_nghe_Ban_hang", "Nguyện vọng: Bán hàng", "customAnswers.tap_nghe_nguyen_vong", "Bán hàng"),
    checkboxField("Tap_nghe_Dong_goi", "Nguyện vọng: Đóng gói", "customAnswers.tap_nghe_nguyen_vong", "Đóng gói"),
    checkboxField("Tap_nghe_Khac", "Nguyện vọng: Khác", "customAnswers.tap_nghe_nguyen_vong", "Khác"),
    { key: "Cong_viec_khac", label: "Công việc tập nghề khác", valueKind: "text", required: false, sourcePath: "customAnswers.cong_viec_khac" },

    { key: "Ngay_nhan_viec", label: "Ngày nhận việc", valueKind: "date", required: true, sourcePath: "startingDate" },
    { key: "Ngay_tiep_nhan", label: "Ngày tiếp nhận", valueKind: "date", required: false, sourcePath: "startingDate" },
    { key: "Nguoi_tiep_nhan", label: "Người tiếp nhận", valueKind: "computed", required: false, sourcePath: "CURRENT_USER_NAME" },
    { key: "Dia_diem_ky", label: "Địa điểm ký", valueKind: "text", required: false, sourcePath: "location" },
    { key: "Ngay_ky_day", label: "Ngày ký", valueKind: "computed", required: false, sourcePath: "startingDate" },
    { key: "Ngay_ky_month", label: "Tháng ký", valueKind: "computed", required: false, sourcePath: "startingDate" },
    { key: "Ngay_ky_year", label: "Năm ký", valueKind: "computed", required: false, sourcePath: "startingDate" },
    { key: "Nam_thue", label: "Năm thuế", valueKind: "computed", required: false, sourcePath: "startingDate" },
    { key: "Code", label: "Mã hồ sơ", valueKind: "text", required: false, sourcePath: "code" },
    { key: "Email", label: "Email", valueKind: "text", required: false, sourcePath: "customAnswers.email" },
    { key: "So_dinh_danh_cu", label: "Số định danh cũ", valueKind: "text", required: false, sourcePath: "customAnswers.so_dinh_danh_cu" },
  ],
};

/** Fails fast in tests if the hand-reviewed contract ever drifts from the token tuple. */
export const CONTRACT_PLACEHOLDERS = DANG_KY_TAP_NGHE_FIELD_CONTRACT.fields.map((field) => field.key).sort();
export const REQUIRED_PLACEHOLDERS = DANG_KY_TAP_NGHE_FIELD_CONTRACT.fields
  .filter((field) => field.required)
  .map((field) => field.key)
  .sort();
export const CHECKBOX_PLACEHOLDERS = DANG_KY_TAP_NGHE_FIELD_CONTRACT.fields
  .filter((field) => field.valueKind === "checkbox")
  .map((field) => field.key)
  .sort();
