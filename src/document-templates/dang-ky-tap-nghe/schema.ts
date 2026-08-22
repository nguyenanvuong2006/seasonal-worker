/**
 * Dang_ky_Tap_nghe_Template — schema tài liệu (tài liệu tham khảo).
 *
 * ⚠️ Đây CHỈ là tài liệu mô tả cấu trúc 5 phần + danh sách 49 canonical placeholder
 * active của template gốc. Source of truth cho MAPPING (placeholder → data)
 * nằm trong bảng merge_template_fields (Mapping Inspector), KHÔNG hardcode ở đây.
 *
 * Template HTML bên dưới dùng ĐÚNG các token `<<...>>` này; Data Resolver fill giá trị.
 */

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
