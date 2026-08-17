-- ============================================================
-- 2026-08-17 — WORKFLOW TIẾP NHẬN: TÁCH VAI TRÒ + TÁCH "XẾP VIỆC" / "NHẬP DW DATA"
-- ------------------------------------------------------------
-- Mục tiêu (đề bài): workflow tiếp nhận lao động thời vụ/tập nghề phải phản
-- ánh đúng luồng thực tế — Recruiter xếp việc RỒI MỚI nhập DW Data (hành động
-- tách bạch, không suy diễn từ status); 4 vai trò nghiệp vụ mới (HR_SUPPORT,
-- ADMINISTRATION, FINGERPRINT_STAFF, MEAL_STAFF) qua đúng kiến trúc Dynamic
-- RBAC V2 hiện có — KHÔNG hard-code role trong source, KHÔNG coi
-- ADMINISTRATION là ADMIN.
--
-- An toàn:
--   * Idempotent — ADD COLUMN IF NOT EXISTS / INSERT ... ON CONFLICT DO NOTHING.
--   * KHÔNG DROP / xoá cột / đổi kiểu / DELETE dữ liệu nghiệp vụ.
--   * Backfill chỉ set các cột MỚI (NULL -> giá trị suy ra an toàn), không đổi
--     bất kỳ cột nghiệp vụ nào đã có.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- PHẦN 1 — CỘT TRACKING MỚI (mục IV, VI, VIII, XII)
-- ------------------------------------------------------------
-- "Đã nhập DW Data" là MỘT hành động rõ ràng, tách biệt khỏi status/is_imported
-- (chỉ phản ánh đã APPROVED/xếp việc — KHÔNG phải đã có bản ghi DW Data).
ALTER TABLE daily_applications
  ADD COLUMN IF NOT EXISTS dw_imported_at timestamptz,
  ADD COLUMN IF NOT EXISTS dw_imported_by varchar(64);

COMMENT ON COLUMN daily_applications.dw_imported_at IS
  'Nguồn sự thật RÕ NGHĨA cho "đã nhập vào DW Data" — set bởi hành động Recruiter riêng biệt (POST /api/bulk-import/dw), KHÔNG suy diễn từ status/is_imported.';
COMMENT ON COLUMN daily_applications.dw_imported_by IS 'Username Recruiter thực hiện Nhập vào DW Data.';

CREATE INDEX IF NOT EXISTS daily_app_dw_imported_idx ON daily_applications (reg_date, dw_imported_at);

-- Mã số công nhật (dw_data.code) do ADMINISTRATION cấp/cập nhật; IT CODE
-- (dw_data.it_code) do FINGERPRINT_STAFF cấp/cập nhật — mỗi sự kiện 1 cặp
-- tracking riêng để list nghiệp vụ hiển thị "Trạng thái cập nhật" nhanh mà
-- không phải join audit_logs cho từng dòng.
ALTER TABLE dw_data
  ADD COLUMN IF NOT EXISTS daily_code_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS daily_code_updated_by varchar(64),
  ADD COLUMN IF NOT EXISTS it_code_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS it_code_updated_by varchar(64);

COMMENT ON COLUMN dw_data.daily_code_updated_at IS 'Lần cập nhật Mã số công nhật (dw_data.code) gần nhất bởi ADMINISTRATION.';
COMMENT ON COLUMN dw_data.it_code_updated_at IS 'Lần cập nhật IT CODE (dw_data.it_code) gần nhất bởi FINGERPRINT_STAFF.';

-- ------------------------------------------------------------
-- PHẦN 2 — BACKFILL AN TOÀN (không destructive, chỉ set cột mới còn NULL)
-- ------------------------------------------------------------
-- Hồ sơ đã APPROVED + đã liên kết DW từ trước migration này: coi như đã
-- "nhập DW" (đúng thực tế lịch sử) để hàng chờ Administration/Fingerprint/Meal
-- không hiển thị nhầm hàng chục nghìn hồ sơ cũ là "chưa xử lý".
UPDATE daily_applications
   SET dw_imported_at = updated_at,
       dw_imported_by = 'SYSTEM_BACKFILL'
 WHERE dw_imported_at IS NULL
   AND is_imported = true
   AND dw_id IS NOT NULL;

UPDATE dw_data
   SET daily_code_updated_at = created_at,
       daily_code_updated_by = 'SYSTEM_BACKFILL'
 WHERE daily_code_updated_at IS NULL
   AND code IS NOT NULL;

UPDATE dw_data
   SET it_code_updated_at = created_at,
       it_code_updated_by = 'SYSTEM_BACKFILL'
 WHERE it_code_updated_at IS NULL
   AND it_code IS NOT NULL;

-- ------------------------------------------------------------
-- PHẦN 3 — 4 VAI TRÒ NGHIỆP VỤ MỚI (mục II, III) qua catalog Dynamic RBAC V2
-- ------------------------------------------------------------
INSERT INTO roles (key, name, description, is_system, is_active, sort_order) VALUES
  ('HR_SUPPORT', 'Nhân viên hỗ trợ',
   'Dùng Document Merge cho hồ sơ đủ điều kiện: preview, merge, tạo PDF, gửi tài liệu. KHÔNG có quyền Recruiter mặc định, không sửa mã công nhật, không quản trị hệ thống.',
   false, true, 5),
  ('ADMINISTRATION', 'Nhân viên hành chính',
   'Vai trò nghiệp vụ hành chính (KHÔNG PHẢI Quản trị viên hệ thống): xem danh sách đã nhập DW, nhập/cập nhật Mã số công nhật, submit hàng loạt.',
   false, true, 6),
  ('FINGERPRINT_STAFF', 'Nhân viên phụ trách vân tay',
   'Xem lao động đã có Mã số công nhật, nhập/cập nhật IT CODE, submit.',
   false, true, 7),
  ('MEAL_STAFF', 'Nhân viên báo cơm',
   'Xem danh sách đủ điều kiện báo cơm, xuất danh sách hôm nay. Không chỉnh sửa hồ sơ.',
   false, true, 8)
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- PHẦN 4 — QUYỀN MỚI (mục X)
-- ------------------------------------------------------------
-- LƯU Ý: KHÔNG có key ".edit" riêng cho administration.daily_code / fingerprint —
-- backend chỉ enforce ".submit" (route PATCH duy nhất ghi dữ liệu), một key
-- ".edit" không gắn với bất kỳ endpoint nào sẽ tạo ảo giác "cấu hình được độc
-- lập" cho Admin trong khi thực tế không có tác dụng gì (mục X, XV).
INSERT INTO permissions (key, name, group_name, is_system) VALUES
  ('dw.import_from_registration', 'Nhập vào DW Data (từ Đăng ký)', 'dw_data', true),
  ('administration.daily_code.view', 'Xem hàng chờ Mã số công nhật', 'hanh_chinh', true),
  ('administration.daily_code.submit', 'Submit Mã số công nhật hàng loạt', 'hanh_chinh', true),
  ('fingerprint.view', 'Xem hàng chờ IT Code / Vân tay', 'van_tay', true),
  ('fingerprint.submit', 'Submit IT Code hàng loạt', 'van_tay', true),
  ('meal.view', 'Xem danh sách Báo cơm', 'bao_com', true),
  ('meal.export', 'Xuất danh sách Báo cơm', 'bao_com', true)
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- PHẦN 5 — BASELINE role_permissions (mục X) — KHÔNG đè cấu hình admin đã có
-- ------------------------------------------------------------
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  -- HR_RECRUITER: thêm quyền Nhập vào DW Data (hành động tách riêng khỏi duyệt).
  ('HR_RECRUITER', 'dw.import_from_registration', true),
  -- HR_SUPPORT — chỉ Document Merge + xem tối thiểu Daily Application.
  ('HR_SUPPORT', 'registrations.view', true),
  ('HR_SUPPORT', 'document_merge.view', true),
  ('HR_SUPPORT', 'document_merge.execute', true),
  ('HR_SUPPORT', 'document_merge.history.view', true),
  ('HR_SUPPORT', 'dashboard.view', true),
  ('HR_SUPPORT', 'global_search.use', true),
  -- ADMINISTRATION — chỉ Mã số công nhật + xem DW tối thiểu.
  ('ADMINISTRATION', 'administration.daily_code.view', true),
  ('ADMINISTRATION', 'administration.daily_code.submit', true),
  ('ADMINISTRATION', 'dw.view', true),
  ('ADMINISTRATION', 'dashboard.view', true),
  ('ADMINISTRATION', 'global_search.use', true),
  -- FINGERPRINT_STAFF — chỉ IT Code/Vân tay.
  ('FINGERPRINT_STAFF', 'fingerprint.view', true),
  ('FINGERPRINT_STAFF', 'fingerprint.submit', true),
  ('FINGERPRINT_STAFF', 'dashboard.view', true),
  ('FINGERPRINT_STAFF', 'global_search.use', true),
  -- MEAL_STAFF — chỉ Báo cơm, KHÔNG PII mặc định (Admin cấp riêng nếu cần).
  ('MEAL_STAFF', 'meal.view', true),
  ('MEAL_STAFF', 'meal.export', true),
  ('MEAL_STAFF', 'dashboard.view', true)
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO audit_logs (user_id, username, action, target_type, category, details)
VALUES (
  NULL,
  'SYSTEM',
  'MIGRATION_WORKFLOW_ROLE_SEPARATION',
  'daily_applications',
  'SYSTEM',
  jsonb_build_object(
    'migration', '2026-08-17-workflow-role-separation.sql',
    'new_columns', jsonb_build_array(
      'daily_applications.dw_imported_at', 'daily_applications.dw_imported_by',
      'dw_data.daily_code_updated_at', 'dw_data.daily_code_updated_by',
      'dw_data.it_code_updated_at', 'dw_data.it_code_updated_by'
    ),
    'new_roles', jsonb_build_array('HR_SUPPORT', 'ADMINISTRATION', 'FINGERPRINT_STAFF', 'MEAL_STAFF'),
    'new_permissions', jsonb_build_array(
      'dw.import_from_registration',
      'administration.daily_code.view', 'administration.daily_code.submit',
      'fingerprint.view', 'fingerprint.submit',
      'meal.view', 'meal.export'
    )
  )
);

COMMIT;

-- VERIFY sau migration:
-- SELECT key, name, is_system FROM roles WHERE key IN ('HR_SUPPORT','ADMINISTRATION','FINGERPRINT_STAFF','MEAL_STAFF');
-- SELECT role, permission_key, allowed FROM role_permissions WHERE role IN ('HR_SUPPORT','ADMINISTRATION','FINGERPRINT_STAFF','MEAL_STAFF') ORDER BY role, permission_key;
-- SELECT count(*) FILTER (WHERE dw_imported_at IS NOT NULL) AS backfilled, count(*) AS total FROM daily_applications;

-- ============================================================
-- ROLLBACK (chạy thủ công nếu cần quay lui — KHÔNG xoá dữ liệu nghiệp vụ)
-- ------------------------------------------------------------
-- BEGIN;
--   DELETE FROM role_permissions WHERE role IN ('HR_SUPPORT','ADMINISTRATION','FINGERPRINT_STAFF','MEAL_STAFF');
--   DELETE FROM role_permissions WHERE role = 'HR_RECRUITER' AND permission_key = 'dw.import_from_registration';
--   DELETE FROM roles WHERE key IN ('HR_SUPPORT','ADMINISTRATION','FINGERPRINT_STAFF','MEAL_STAFF');
--   DELETE FROM permissions WHERE key IN (
--     'dw.import_from_registration',
--     'administration.daily_code.view','administration.daily_code.submit',
--     'fingerprint.view','fingerprint.submit','meal.view','meal.export'
--   );
--   -- Cột mới đều NULLable: GIỮ LẠI an toàn (khuyến nghị). Chỉ xoá nếu chắc chắn không cần:
--   -- ALTER TABLE daily_applications DROP COLUMN IF EXISTS dw_imported_at, DROP COLUMN IF EXISTS dw_imported_by;
--   -- ALTER TABLE dw_data DROP COLUMN IF EXISTS daily_code_updated_at, DROP COLUMN IF EXISTS daily_code_updated_by,
--   --   DROP COLUMN IF EXISTS it_code_updated_at, DROP COLUMN IF EXISTS it_code_updated_by;
-- COMMIT;
-- ============================================================
