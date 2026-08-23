# Trainee-registration canonical field-mapping report

**Canonical source:** `templates/document-merge/trainee-registration/canonical-source.html`  
**Canonical source SHA-256:** `22e987f76ff0100f8a7a3f9c6fcda72f1465bbf353f909664d923eed41343bd2`  
**Logical document pages:** 6  
**Production template syntax:** semantic `{{Field}}`; candidate values are escaped by the HTML renderer.

## PASS summary

| Check | Result |
| --- | --- |
| Placeholder occurrences in six production pages | 76 |
| Unique semantic placeholders | 49 |
| Canonical contract fields | 49 |
| Unmapped placeholders | **0** |
| Unmapped required placeholders | **0** |
| Result | **PASS** |

The database table `merge_template_fields` remains the runtime mapping source of truth and is snapshotted with every HTML/PDF job. This report is the reviewed first-party contract for the canonical visual source. A `CHECKBOX_OPTION` never treats an unchecked option as missing: it renders `☐`; the matching option renders `☒`.

## Field inventory and canonical mapping

| Placeholder in canonical HTML | Canonical field | Required | Runtime mapping | Formatter used | Checkbox/group logic |
| --- | --- | --- | --- | --- | --- |
`{{Ho_ten}}` | Họ và tên | Required | `CORE_FIELD` → `fullName` | `RAW` | —
`{{Ngay_sinh}}` | Ngày sinh | Required | `CORE_FIELD` → `dob` | `DATE_DDMMYYYY` | —
`{{Dia_chi_thuong_tru}}` | Địa chỉ thường trú | Required | `CORE_FIELD` → `permanentAddress` | `RAW` | —
`{{Dia_chi_tam_tru}}` | Địa chỉ tạm trú | Required | `CORE_FIELD` → `residentialAddress` | `RAW` | —
`{{So_dien_thoai}}` | Số điện thoại | Required | `CORE_FIELD` → `phone` | `RAW` | —
`{{So_CCCD}}` | Số CCCD | Required | `CORE_FIELD` → `cccd` | `RAW` | —
`{{Ngay_cap_CCCD}}` | Ngày cấp CCCD | Optional | `CORE_FIELD` → `dateOfIssue` | `DATE_DDMMYYYY` | —
`{{Noi_cap_CCCD}}` | Nơi cấp CCCD | Optional | `CORE_FIELD` → `placeOfIssue` | `RAW` | —
`{{dia_chi_cu_tru}}` | Địa chỉ cư trú | Optional | `CORE_FIELD` → `permanentAddress` | `RAW` | —
`{{Tien_an_tien_su_Khong}}` | Tiền án, tiền sự: Không | Optional | `CHECKBOX_OPTION` → `customAnswers.tien_an_tien_su` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.tien_an_tien_su = “Không” → ☒; otherwise ☐
`{{Tien_an_tien_su_Co}}` | Tiền án, tiền sự: Có | Optional | `CHECKBOX_OPTION` → `customAnswers.tien_an_tien_su` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.tien_an_tien_su = “Có” → ☒; otherwise ☐
`{{Da_tung_lam_DHF_Khong}}` | Đã từng làm DHF: Không | Optional | `CHECKBOX_OPTION` → `declaredType` | `CHECKBOX_OPTION → ☒ / ☐` | match declaredType = “NEW” → ☒; otherwise ☐
`{{Da_tung_lam_DHF_Co}}` | Đã từng làm DHF: Có | Optional | `CHECKBOX_OPTION` → `declaredType` | `CHECKBOX_OPTION → ☒ / ☐` | match declaredType = “OLD” → ☒; otherwise ☐
`{{Loai_cong_viec_Nhan_vien}}` | Loại công việc: Nhân viên | Optional | `CHECKBOX_OPTION` → `customAnswers.loai_cong_viec_truoc_day` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.loai_cong_viec_truoc_day = “Nhân viên” → ☒; otherwise ☐
`{{Loai_cong_viec_Cong_nhan}}` | Loại công việc: Công nhân | Optional | `CHECKBOX_OPTION` → `customAnswers.loai_cong_viec_truoc_day` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.loai_cong_viec_truoc_day = “Công nhân” → ☒; otherwise ☐
`{{Loai_cong_viec_Lao_dong_tap_nghe}}` | Loại công việc: Lao động tập nghề | Optional | `CHECKBOX_OPTION` → `customAnswers.loai_cong_viec_truoc_day` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.loai_cong_viec_truoc_day = “Lao động tập nghề” → ☒; otherwise ☐
`{{Khu_vuc_Da_Lat}}` | Khu vực: Đà Lạt | Optional | `CHECKBOX_OPTION` → `customAnswers.khu_vuc_lam_viec_truoc_day` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.khu_vuc_lam_viec_truoc_day = “Đà Lạt” → ☒; otherwise ☐
`{{Khu_vuc_Da_Quy}}` | Khu vực: Đa Quý | Optional | `CHECKBOX_OPTION` → `customAnswers.khu_vuc_lam_viec_truoc_day` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.khu_vuc_lam_viec_truoc_day = “Đa Quý” → ☒; otherwise ☐
`{{Khu_vuc_Da_Ron}}` | Khu vực: Đạ Ròn | Optional | `CHECKBOX_OPTION` → `customAnswers.khu_vuc_lam_viec_truoc_day` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.khu_vuc_lam_viec_truoc_day = “Đạ Ròn” → ☒; otherwise ☐
`{{Khu_vuc_Lam_Ha}}` | Khu vực: Lâm Hà | Optional | `CHECKBOX_OPTION` → `customAnswers.khu_vuc_lam_viec_truoc_day` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.khu_vuc_lam_viec_truoc_day = “Lâm Hà” → ☒; otherwise ☐
`{{Khu_vuc_Khac}}` | Khu vực: Khác | Optional | `CHECKBOX_OPTION` → `customAnswers.khu_vuc_lam_viec_truoc_day` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.khu_vuc_lam_viec_truoc_day = “Khác” → ☒; otherwise ☐
`{{Cong_viec_hien_tai_Sinh_vien}}` | Công việc hiện tại: Sinh viên | Optional | `CHECKBOX_OPTION` → `customAnswers.cong_viec_hien_tai` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.cong_viec_hien_tai = “Sinh viên” → ☒; otherwise ☐
`{{Cong_viec_hien_tai_Khac}}` | Công việc hiện tại: Khác | Optional | `CHECKBOX_OPTION` → `customAnswers.cong_viec_hien_tai` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.cong_viec_hien_tai = “Khác” → ☒; otherwise ☐
`{{Cong_viec_hien_tai_khac}}` | Công việc hiện tại khác | Optional | `DYNAMIC_ANSWER` → `customAnswers.cong_viec_hien_tai_khac` | `RAW` | —
`{{Ten_truong}}` | Tên trường | Optional | `DYNAMIC_ANSWER` → `customAnswers.ten_truong` | `RAW` | —
`{{TKNH_Da_co}}` | Tài khoản ngân hàng: Đã có | Optional | `CHECKBOX_OPTION` → `customAnswers.tinh_trang_tknh` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.tinh_trang_tknh = “Đã có” → ☒; otherwise ☐
`{{TKNH_Chua_co}}` | Tài khoản ngân hàng: Chưa có | Optional | `CHECKBOX_OPTION` → `customAnswers.tinh_trang_tknh` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.tinh_trang_tknh = “Chưa có” → ☒; otherwise ☐
`{{So_tai_khoan}}` | Số tài khoản | Optional | `DYNAMIC_ANSWER` → `customAnswers.so_tai_khoan` | `RAW` | —
`{{Ten_ngan_hang}}` | Tên ngân hàng | Optional | `DYNAMIC_ANSWER` → `customAnswers.ten_ngan_hang` | `RAW` | —
`{{Thu_nhap_Chi_DHF}}` | Nguồn thu nhập: Chỉ DHF | Optional | `CHECKBOX_OPTION` → `customAnswers.nguon_thu_nhap` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.nguon_thu_nhap = “Chỉ phát sinh tại Dalat Hasfarm” → ☒; otherwise ☐
`{{Thu_nhap_Ngoai_DHF}}` | Nguồn thu nhập: Ngoài DHF | Optional | `CHECKBOX_OPTION` → `customAnswers.nguon_thu_nhap` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.nguon_thu_nhap = “Phát sinh ngoài Dalat Hasfarm” → ☒; otherwise ☐
`{{Cong_ty_thu_nhap_khac}}` | Đơn vị thu nhập khác | Optional | `DYNAMIC_ANSWER` → `customAnswers.cong_ty_thu_nhap_khac` | `RAW` | —
`{{Dia_diem_thu_nhap_khac}}` | Địa điểm thu nhập khác | Optional | `DYNAMIC_ANSWER` → `customAnswers.dia_diem_thu_nhap_khac` | `RAW` | —
`{{Tap_nghe_Trong_cham_soc_thu_hoach}}` | Nguyện vọng: Trồng/chăm sóc/thu hoạch | Optional | `CHECKBOX_OPTION` → `customAnswers.tap_nghe_nguyen_vong` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.tap_nghe_nguyen_vong = “Trồng, chăm sóc, thu hoạch” → ☒; otherwise ☐
`{{Tap_nghe_Ban_hang}}` | Nguyện vọng: Bán hàng | Optional | `CHECKBOX_OPTION` → `customAnswers.tap_nghe_nguyen_vong` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.tap_nghe_nguyen_vong = “Bán hàng” → ☒; otherwise ☐
`{{Tap_nghe_Dong_goi}}` | Nguyện vọng: Đóng gói | Optional | `CHECKBOX_OPTION` → `customAnswers.tap_nghe_nguyen_vong` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.tap_nghe_nguyen_vong = “Đóng gói” → ☒; otherwise ☐
`{{Tap_nghe_Khac}}` | Nguyện vọng: Khác | Optional | `CHECKBOX_OPTION` → `customAnswers.tap_nghe_nguyen_vong` | `CHECKBOX_OPTION → ☒ / ☐` | match customAnswers.tap_nghe_nguyen_vong = “Khác” → ☒; otherwise ☐
`{{Cong_viec_khac}}` | Công việc tập nghề khác | Optional | `DYNAMIC_ANSWER` → `customAnswers.cong_viec_khac` | `RAW` | —
`{{Ngay_nhan_viec}}` | Ngày nhận việc | Required | `CORE_FIELD` → `startingDate` | `DATE_DDMMYYYY` | —
`{{Ngay_tiep_nhan}}` | Ngày tiếp nhận | Optional | `CORE_FIELD` → `startingDate` | `DATE_DDMMYYYY` | —
`{{Nguoi_tiep_nhan}}` | Người tiếp nhận | Optional | `SYSTEM_FIELD` → `CURRENT_USER_NAME` | `CURRENT_USER_NAME` | —
`{{Dia_diem_ky}}` | Địa điểm ký | Optional | `CORE_FIELD` → `location` | `RAW` | —
`{{Ngay_ky_day}}` | Ngày ký | Optional | `COMPUTED_FIELD` → `startingDate` | `DATE_DAY(startingDate)` | —
`{{Ngay_ky_month}}` | Tháng ký | Optional | `COMPUTED_FIELD` → `startingDate` | `DATE_MONTH(startingDate)` | —
`{{Ngay_ky_year}}` | Năm ký | Optional | `COMPUTED_FIELD` → `startingDate` | `DATE_YEAR(startingDate)` | —
`{{Nam_thue}}` | Năm thuế | Optional | `COMPUTED_FIELD` → `startingDate` | `DATE_YEAR(startingDate)` | —
`{{Code}}` | Mã hồ sơ | Optional | `CORE_FIELD` → `code` | `RAW` | —
`{{Email}}` | Email | Optional | `DYNAMIC_ANSWER` → `customAnswers.email` | `RAW` | —
`{{So_dinh_danh_cu}}` | Số định danh cũ | Optional | `DYNAMIC_ANSWER` → `customAnswers.so_dinh_danh_cu` | `RAW` | —

## Intentional transformations from the supplied visual source

The production body retains all six `.page` legal sections, typography, spacing, borders, table structure, signature areas, and A4 print rules. Only authoring-only markup is omitted: toolbar, page tabs, Handlebars/Jinja/Blade code panels, page labels, buttons, scripts, and blue placeholder highlighting. The source’s visual `.f` field markers become `.merge-value` text spans or semantic `.chk` checkbox spans; no candidate values are stored in the template.

The generated production module is checked against the canonical-source SHA-256 in `src/document-templates/dang-ky-tap-nghe/template.test.ts`. Run `npm run sync:trainee-template` followed by `node --import tsx scripts/generate-trainee-registration-mapping-report.mjs` after an approved canonical-source edit.
