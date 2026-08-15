-- ============================================================
-- FIRST VOCATIONAL REGISTRATION MERGE TEMPLATE
-- Google Doc: Dang_ky_Tap_nghe_Template
-- ID: 10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE
--
-- Goals:
-- 1) Seed only the dynamic applicant questions that are missing from core tables.
-- 2) Seed the first Document Merge template (Document Kind B / NEW applicant).
-- 3) Map all 51 unique placeholders found in the real Google Doc.
--
-- Safe/idempotent:
-- - no DROP / DELETE / destructive UPDATE
-- - existing form_questions are kept as-is (ON CONFLICT DO NOTHING)
-- - template is inserted only if this Google Doc ID does not already exist
-- - field mappings upsert only this template's placeholder mapping metadata
-- ============================================================

-- ------------------------------------------------------------
-- A. Dynamic questions: values live in daily_applications.custom_answers
-- ------------------------------------------------------------
INSERT INTO form_questions (
  field_key, question_text, field_type, options, is_required, sort_order,
  is_active, visible_to_applicants, target_audience, skip_for_returning,
  aliases, export_column_name
)
VALUES
  ('dia_chi_thuong_tru', 'Địa chỉ thường trú theo CCCD/hộ khẩu', 'TEXT', '[]'::jsonb, true, 110, true, true, 'NEW_ONLY', true, '["Dia_chi_thuong_tru","Địa chỉ thường trú"]'::jsonb, 'Địa chỉ thường trú'),
  ('ngay_cap_cccd', 'Ngày cấp CCCD', 'DATE', '[]'::jsonb, true, 120, true, true, 'NEW_ONLY', true, '["Ngay_cap_CCCD","Ngày cấp CCCD"]'::jsonb, 'Ngày cấp CCCD'),
  ('noi_cap_cccd', 'Nơi cấp CCCD', 'TEXT', '[]'::jsonb, true, 130, true, true, 'NEW_ONLY', true, '["Noi_cap_CCCD","Nơi cấp CCCD"]'::jsonb, 'Nơi cấp CCCD'),
  ('tien_an_tien_su', 'Bạn đã có tiền án, tiền sự trước đây?', 'BOOLEAN', '["Có","Không"]'::jsonb, true, 140, true, true, 'ALL', false, '["Tien_an_tien_su"]'::jsonb, 'Tiền án tiền sự'),
  ('loai_cong_viec_truoc_day', 'Loại công việc trước đây tại Dalat Hasfarm (nếu có)', 'SELECT', '["Nhân viên","Công nhân","Lao động tập nghề"]'::jsonb, false, 150, true, true, 'RETURNING_ONLY', false, '["Loai_cong_viec"]'::jsonb, 'Loại công việc trước đây'),
  ('khu_vuc_lam_viec_truoc_day', 'Khu vực làm việc trước đây tại Dalat Hasfarm (nếu có)', 'SELECT', '["Đà Lạt","Đa Quý","Đạ Ròn","Lâm Hà","Khác"]'::jsonb, false, 160, true, true, 'RETURNING_ONLY', false, '["Khu_vuc"]'::jsonb, 'Khu vực làm việc trước đây'),
  ('cong_viec_hien_tai', 'Công việc hiện tại', 'SELECT', '["Sinh viên","Khác"]'::jsonb, true, 170, true, true, 'ALL', false, '["Cong_viec_hien_tai"]'::jsonb, 'Công việc hiện tại'),
  ('ten_truong', 'Tên trường (nếu hiện là sinh viên)', 'TEXT', '[]'::jsonb, false, 180, true, true, 'ALL', false, '["Ten_truong"]'::jsonb, 'Tên trường'),
  ('cong_viec_hien_tai_khac', 'Công việc hiện tại khác (nếu có)', 'TEXT', '[]'::jsonb, false, 190, true, true, 'ALL', false, '["Cong_viec_hien_tai_khac"]'::jsonb, 'Công việc hiện tại khác'),
  ('tinh_trang_tknh', 'Bạn đã có tài khoản ngân hàng chính chủ chưa?', 'SELECT', '["Đã có","Chưa có"]'::jsonb, true, 200, true, true, 'ALL', false, '["TKNH"]'::jsonb, 'Tình trạng tài khoản ngân hàng'),
  ('so_tai_khoan', 'Số tài khoản ngân hàng chính chủ (nếu đã có)', 'TEXT', '[]'::jsonb, false, 210, true, true, 'ALL', false, '["So_tai_khoan"]'::jsonb, 'Số tài khoản'),
  ('ten_ngan_hang', 'Tên ngân hàng (nếu đã có tài khoản)', 'TEXT', '[]'::jsonb, false, 220, true, true, 'ALL', false, '["Ten_ngan_hang"]'::jsonb, 'Tên ngân hàng'),
  ('nguon_thu_nhap', 'Nguồn thu nhập trong năm', 'SELECT', '["Chỉ phát sinh tại Dalat Hasfarm","Phát sinh ngoài Dalat Hasfarm"]'::jsonb, true, 230, true, true, 'ALL', false, '["Thu_nhap"]'::jsonb, 'Nguồn thu nhập'),
  ('cong_ty_thu_nhap_khac', 'Tên Công ty/Đơn vị có thu nhập khác (nếu có)', 'TEXT', '[]'::jsonb, false, 240, true, true, 'ALL', false, '["Cong_ty_thu_nhap_khac"]'::jsonb, 'Công ty thu nhập khác'),
  ('dia_diem_thu_nhap_khac', 'Địa điểm Công ty/Đơn vị có thu nhập khác (nếu có)', 'TEXT', '[]'::jsonb, false, 250, true, true, 'ALL', false, '["Dia_diem_thu_nhap_khac"]'::jsonb, 'Địa điểm thu nhập khác'),
  ('tap_nghe_nguyen_vong', 'Công việc bạn đăng ký tập nghề', 'SELECT', '["Trồng, chăm sóc, thu hoạch","Bán hàng","Đóng gói","Khác"]'::jsonb, true, 260, true, true, 'ALL', false, '["Tap_nghe"]'::jsonb, 'Nguyện vọng tập nghề'),
  ('cong_viec_khac', 'Công việc tập nghề khác (nếu chọn Khác)', 'TEXT', '[]'::jsonb, false, 270, true, true, 'ALL', false, '["Cong_viec_khac"]'::jsonb, 'Công việc khác'),
  ('email', 'Email cá nhân (nếu có)', 'TEXT', '[]'::jsonb, false, 280, true, true, 'ALL', false, '["Email"]'::jsonb, 'Email'),
  ('so_dinh_danh_cu', 'Số định danh cá nhân đã cấp trước đó (nếu có)', 'TEXT', '[]'::jsonb, false, 290, true, true, 'ALL', false, '["So_dinh_danh_cu"]'::jsonb, 'Số định danh cũ')
ON CONFLICT (field_key) DO NOTHING;

-- ------------------------------------------------------------
-- B. First Merge Template
-- ------------------------------------------------------------
INSERT INTO merge_templates (
  name, description, google_doc_id, output_file_name_pattern,
  default_merge_mode, data_sources, document_kind, is_active,
  created_by, updated_by
)
SELECT
  'Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế',
  'Template gốc Dalat Hasfarm: Giấy đăng ký tập nghề, Quy định tập nghề, Bản cam kết thuế, Giấy ủy quyền và Tờ khai đăng ký thuế.',
  '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE',
  'Ho_so_tap_nghe_<<Ho_ten>>_<<Ngay_nhan_viec>>',
  'ONE_DOCUMENT',
  '["daily_applications","dw_data","departments","worker_profiles","form_questions"]'::jsonb,
  'B',
  true,
  'system',
  'system'
WHERE NOT EXISTS (
  SELECT 1 FROM merge_templates
  WHERE google_doc_id = '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE'
);

-- ------------------------------------------------------------
-- C. All 51 unique placeholders audited from the real Google Doc
-- ------------------------------------------------------------
WITH target_template AS (
  SELECT id FROM merge_templates
  WHERE google_doc_id = '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE'
  ORDER BY created_at ASC
  LIMIT 1
), mappings(placeholder, source_type, source_field, source_path, option_value, format_type, fallback_value, is_required) AS (
  VALUES
    ('Ho_ten','CORE_FIELD',NULL,'fullName',NULL,'RAW',NULL,true),
    ('Ngay_sinh','CORE_FIELD',NULL,'dob',NULL,'DATE_DDMMYYYY',NULL,true),
    ('Dia_chi_thuong_tru','CORE_FIELD',NULL,'permanentAddress',NULL,'RAW',NULL,true),
    ('Dia_chi_tam_tru','CORE_FIELD',NULL,'residentialAddress',NULL,'RAW',NULL,true),
    ('So_dien_thoai','CORE_FIELD',NULL,'phone',NULL,'RAW',NULL,true),
    ('So_CCCD','CORE_FIELD',NULL,'cccd',NULL,'RAW',NULL,true),
    ('Ngay_cap_CCCD','CORE_FIELD',NULL,'dateOfIssue',NULL,'DATE_DDMMYYYY',NULL,false),
    ('Noi_cap_CCCD','CORE_FIELD',NULL,'placeOfIssue',NULL,'RAW',NULL,false),

    ('Tien_an_tien_su_Khong','CHECKBOX_OPTION',NULL,'customAnswers.tien_an_tien_su','Không','RAW',NULL,false),
    ('Tien_an_tien_su_Co','CHECKBOX_OPTION',NULL,'customAnswers.tien_an_tien_su','Có','RAW',NULL,false),
    ('Da_tung_lam_DHF_Khong','CHECKBOX_OPTION',NULL,'declaredType','NEW','RAW',NULL,false),
    ('Da_tung_lam_DHF_Co','CHECKBOX_OPTION',NULL,'declaredType','OLD','RAW',NULL,false),

    ('Loai_cong_viec_Nhan_vien','CHECKBOX_OPTION',NULL,'customAnswers.loai_cong_viec_truoc_day','Nhân viên','RAW',NULL,false),
    ('Loai_cong_viec_Cong_nhan','CHECKBOX_OPTION',NULL,'customAnswers.loai_cong_viec_truoc_day','Công nhân','RAW',NULL,false),
    ('Loai_cong_viec_Lao_dong_tap_nghe','CHECKBOX_OPTION',NULL,'customAnswers.loai_cong_viec_truoc_day','Lao động tập nghề','RAW',NULL,false),

    ('Khu_vuc_Da_Lat','CHECKBOX_OPTION',NULL,'customAnswers.khu_vuc_lam_viec_truoc_day','Đà Lạt','RAW',NULL,false),
    ('Khu_vuc_Da_Quy','CHECKBOX_OPTION',NULL,'customAnswers.khu_vuc_lam_viec_truoc_day','Đa Quý','RAW',NULL,false),
    ('Khu_vuc_Da_Ron','CHECKBOX_OPTION',NULL,'customAnswers.khu_vuc_lam_viec_truoc_day','Đạ Ròn','RAW',NULL,false),
    ('Khu_vuc_Lam_Ha','CHECKBOX_OPTION',NULL,'customAnswers.khu_vuc_lam_viec_truoc_day','Lâm Hà','RAW',NULL,false),
    ('Khu_vuc_Khac','CHECKBOX_OPTION',NULL,'customAnswers.khu_vuc_lam_viec_truoc_day','Khác','RAW',NULL,false),

    ('Cong_viec_hien_tai_Sinh_vien','CHECKBOX_OPTION',NULL,'customAnswers.cong_viec_hien_tai','Sinh viên','RAW',NULL,false),
    ('Ten_truong','DYNAMIC_ANSWER',NULL,'customAnswers.ten_truong',NULL,'RAW',NULL,false),
    ('Cong_viec_hien_tai_Khac','CHECKBOX_OPTION',NULL,'customAnswers.cong_viec_hien_tai','Khác','RAW',NULL,false),
    ('Cong_viec_hien_tai_khac','DYNAMIC_ANSWER',NULL,'customAnswers.cong_viec_hien_tai_khac',NULL,'RAW',NULL,false),

    ('TKNH_Da_co','CHECKBOX_OPTION',NULL,'customAnswers.tinh_trang_tknh','Đã có','RAW',NULL,false),
    ('TKNH_Chua_co','CHECKBOX_OPTION',NULL,'customAnswers.tinh_trang_tknh','Chưa có','RAW',NULL,false),
    ('So_tai_khoan','DYNAMIC_ANSWER',NULL,'customAnswers.so_tai_khoan',NULL,'RAW',NULL,false),
    ('Ten_ngan_hang','DYNAMIC_ANSWER',NULL,'customAnswers.ten_ngan_hang',NULL,'RAW',NULL,false),

    ('Nam_thue','COMPUTED_FIELD','DATE_YEAR','startingDate',NULL,'RAW',NULL,false),
    ('Thu_nhap_Chi_DHF','CHECKBOX_OPTION',NULL,'customAnswers.nguon_thu_nhap','Chỉ phát sinh tại Dalat Hasfarm','RAW',NULL,false),
    ('Thu_nhap_Ngoai_DHF','CHECKBOX_OPTION',NULL,'customAnswers.nguon_thu_nhap','Phát sinh ngoài Dalat Hasfarm','RAW',NULL,false),
    ('Cong_ty_thu_nhap_khac','DYNAMIC_ANSWER',NULL,'customAnswers.cong_ty_thu_nhap_khac',NULL,'RAW',NULL,false),
    ('Dia_diem_thu_nhap_khac','DYNAMIC_ANSWER',NULL,'customAnswers.dia_diem_thu_nhap_khac',NULL,'RAW',NULL,false),

    ('Tap_nghe_Trong_cham_soc_thu_hoach','CHECKBOX_OPTION',NULL,'customAnswers.tap_nghe_nguyen_vong','Trồng, chăm sóc, thu hoạch','RAW',NULL,false),
    ('Tap_nghe_Ban_hang','CHECKBOX_OPTION',NULL,'customAnswers.tap_nghe_nguyen_vong','Bán hàng','RAW',NULL,false),
    ('Tap_nghe_Dong_goi','CHECKBOX_OPTION',NULL,'customAnswers.tap_nghe_nguyen_vong','Đóng gói','RAW',NULL,false),
    ('Tap_nghe_Khac','CHECKBOX_OPTION',NULL,'customAnswers.tap_nghe_nguyen_vong','Khác','RAW',NULL,false),
    ('Cong_viec_khac','DYNAMIC_ANSWER',NULL,'customAnswers.cong_viec_khac',NULL,'RAW',NULL,false),

    ('Ngay_nhan_viec','CORE_FIELD',NULL,'startingDate',NULL,'DATE_DDMMYYYY',NULL,true),
    ('Nguoi_tiep_nhan','SYSTEM_FIELD','CURRENT_USER_NAME',NULL,NULL,'RAW',NULL,false),
    ('Ngay_tiep_nhan','CORE_FIELD',NULL,'startingDate',NULL,'DATE_DDMMYYYY',NULL,false),

    ('dia_chi_cu_tru','CORE_FIELD',NULL,'permanentAddress',NULL,'RAW',NULL,false),
    ('Dia_diem_ky','CORE_FIELD',NULL,'location',NULL,'RAW','Đà Lạt',false),
    ('Ngay_ky_day','COMPUTED_FIELD','DATE_DAY','startingDate',NULL,'RAW',NULL,false),
    ('Ngay_ky_month','COMPUTED_FIELD','DATE_MONTH','startingDate',NULL,'RAW',NULL,false),
    ('Ngay_ky_year','COMPUTED_FIELD','DATE_YEAR','startingDate',NULL,'RAW',NULL,false),

    ('Code','CORE_FIELD',NULL,'code',NULL,'RAW',NULL,false),
    ('So_hop_dong_dich_vu_thue','STATIC_TEXT',NULL,NULL,NULL,'RAW','',false),
    ('Ngay_hop_dong_dich_vu_thue','STATIC_TEXT',NULL,NULL,NULL,'RAW','',false),
    ('Email','DYNAMIC_ANSWER',NULL,'customAnswers.email',NULL,'RAW',NULL,false),
    ('So_dinh_danh_cu','DYNAMIC_ANSWER',NULL,'customAnswers.so_dinh_danh_cu',NULL,'RAW',NULL,false)
)
INSERT INTO merge_template_fields (
  template_id, placeholder, source_type, source_field, source_path,
  option_value, format_type, fallback_value, is_required,
  is_orphaned, is_suggested
)
SELECT
  t.id, m.placeholder, m.source_type, m.source_field, m.source_path,
  m.option_value, m.format_type, m.fallback_value, m.is_required,
  false, true
FROM target_template t
CROSS JOIN mappings m
ON CONFLICT (template_id, placeholder) DO UPDATE SET
  source_type = EXCLUDED.source_type,
  source_field = EXCLUDED.source_field,
  source_path = EXCLUDED.source_path,
  option_value = EXCLUDED.option_value,
  format_type = EXCLUDED.format_type,
  fallback_value = EXCLUDED.fallback_value,
  is_required = EXCLUDED.is_required,
  is_orphaned = false,
  is_suggested = true,
  updated_at = now();

-- ------------------------------------------------------------
-- D. Verification queries (read-only)
-- Expect: question_count >= 19, template_count = 1, mapped_placeholders = 51
-- ------------------------------------------------------------
SELECT COUNT(*) AS question_count
FROM form_questions
WHERE field_key IN (
  'dia_chi_thuong_tru','ngay_cap_cccd','noi_cap_cccd','tien_an_tien_su',
  'loai_cong_viec_truoc_day','khu_vuc_lam_viec_truoc_day','cong_viec_hien_tai',
  'ten_truong','cong_viec_hien_tai_khac','tinh_trang_tknh','so_tai_khoan','ten_ngan_hang',
  'nguon_thu_nhap','cong_ty_thu_nhap_khac','dia_diem_thu_nhap_khac',
  'tap_nghe_nguyen_vong','cong_viec_khac','email','so_dinh_danh_cu'
);

SELECT COUNT(*) AS template_count
FROM merge_templates
WHERE google_doc_id = '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE';

SELECT COUNT(*) AS mapped_placeholders
FROM merge_template_fields f
JOIN merge_templates t ON t.id = f.template_id
WHERE t.google_doc_id = '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE'
  AND f.is_orphaned = false;
