/**
 * PLACEHOLDER ALIASES — pure deterministic map from a placeholder key to the
 * record field it maps to.
 *
 * These are the EXACT deterministic aliases used by the existing fallback
 * resolver (see `applyFallbackPlaceholders` in preview-merge.ts). They are
 * extracted into this dependency-free module so the Template Diff Engine and
 * the Designer's auto-mapping suggestions can reuse the SAME aliases without
 * importing Google Docs / Drive service code.
 *
 * ADDRESS SEMANTICS (do not change):
 *   Địa chỉ thường trú (permanent / hộ khẩu)  -> permanentAddress
 *   Địa chỉ cư trú     (current residence)    -> residentialAddress
 *   Địa chỉ tạm trú    (temporary residence)  -> residentialAddress
 * These are two DIFFERENT business fields and must never alias into one
 * another. The template-diff engine verifies this invariant (see tests).
 */

/** Common Vietnamese / English placeholder aliases → record field. */
export const FALLBACK_PLACEHOLDER_MAP: Record<string, string> = {
  Ho_ten: "fullName",
  HoTen: "fullName",
  ho_ten: "fullName",
  fullName: "fullName",
  Full_Name: "fullName",
  So_CCCD: "cccd",
  SoCCCD: "cccd",
  CCCD: "cccd",
  cccd: "cccd",
  Ngay_sinh: "dob",
  NgaySinh: "dob",
  dob: "dob",
  Date_of_birth: "dob",
  Gioi_tinh: "gender",
  GioiTinh: "gender",
  gender: "gender",
  So_dien_thoai: "phone",
  SoDienThoai: "phone",
  Dien_thoai: "phone",
  phone: "phone",
  // ADDRESS SEMANTICS — permanentAddress and residentialAddress are two
  // DIFFERENT business fields and must never alias into one another.
  Dia_chi: "residentialAddress",
  DiaChi: "residentialAddress",
  Dia_chi_hien_tai: "residentialAddress",
  residentialAddress: "residentialAddress",
  Dia_chi_thuong_tru: "permanentAddress",
  dia_chi_cu_tru: "residentialAddress",
  Dia_chi_tam_tru: "residentialAddress",
  permanentAddress: "permanentAddress",
  Ngay_cap_CCCD: "dateOfIssue",
  Noi_cap_CCCD: "placeOfIssue",
  Code: "code",
  Email: "email",
  Dia_diem_ky: "location",
  Ngay_dang_ky: "regDate",
  NgayDangKy: "regDate",
  regDate: "regDate",
  Ngay_nhan_viec: "startingDate",
  NgayNhanViec: "startingDate",
  Ngay_tiep_nhan: "startingDate",
  startingDate: "startingDate",
  Bo_phan: "deptName",
  BoPhan: "deptName",
  deptName: "deptName",
  Nhom: "groupName",
  groupName: "groupName",
  Ma_DW: "dwCode",
  dwCode: "dwCode",
  IT_CODE: "itCode",
  itCode: "itCode",
};

/** Placeholder aliases whose source lives in daily_applications.customAnswers. */
export const CUSTOM_ANSWER_PLACEHOLDER_MAP: Record<string, string> = {
  Ten_truong: "ten_truong",
  Cong_viec_hien_tai_khac: "cong_viec_hien_tai_khac",
  So_tai_khoan: "so_tai_khoan",
  Ten_ngan_hang: "ten_ngan_hang",
  Cong_ty_thu_nhap_khac: "cong_ty_thu_nhap_khac",
  Dia_diem_thu_nhap_khac: "dia_diem_thu_nhap_khac",
  Cong_viec_khac: "cong_viec_khac",
  So_dinh_danh_cu: "so_dinh_danh_cu",
};

/**
 * Operator-friendly business label for a known record source field (sourcePath).
 * Used ONLY for presentation in the Designer's placeholder inventory — it never
 * changes a mapping. Unknown/advanced source paths are shown as-is by the caller.
 */
export const SOURCE_FIELD_LABELS: Record<string, string> = {
  fullName: "Họ tên ứng viên",
  cccd: "Số CCCD",
  dob: "Ngày sinh",
  gender: "Giới tính",
  phone: "Số điện thoại",
  permanentAddress: "Địa chỉ thường trú",
  residentialAddress: "Địa chỉ cư trú",
  dateOfIssue: "Ngày cấp CCCD",
  placeOfIssue: "Nơi cấp CCCD",
  code: "Mã hồ sơ",
  email: "Email",
  location: "Địa điểm ký",
  regDate: "Ngày đăng ký",
  startingDate: "Ngày bắt đầu",
  deptName: "Tên bộ phận",
  groupName: "Tên nhóm",
  dwCode: "Mã DW",
  itCode: "Mã IT",
  ten_truong: "Tên trường",
  so_tai_khoan: "Số tài khoản",
  ten_ngan_hang: "Tên ngân hàng",
  so_dinh_danh_cu: "Số định danh cá nhân",
};
