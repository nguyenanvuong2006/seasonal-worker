-- ============================================================
-- MIGRATION — 2026-08-15 — IT CODE / Mã vân tay trên Daily Application
-- ============================================================
-- Chạy file này TRỰC TIẾP trên Neon SQL Editor (hoặc `psql -f`) trước khi deploy nhánh
-- arena/01a00305-seasonal-worker lên Vercel.
--
-- An toàn:
--   * Idempotent — chạy lại nhiều lần không lỗi (ADD COLUMN IF NOT EXISTS /
--     INSERT ... ON CONFLICT DO NOTHING).
--   * KHÔNG DROP/đổi kiểu bất kỳ cột nào, KHÔNG DELETE/UPDATE dữ liệu nghiệp vụ hiện có.
--   * Không dùng initcap()/UPDATE phá huỷ hàng loạt cho họ tên cũ (chỉ thêm cột mới).
-- ============================================================

-- ----------------------------------------------------------------
-- 1) daily_applications.it_code — IT CODE/Mã vân tay của lao động (nullable).
--    Recruiter nhập tại cột Daily Application; đồng bộ với dw_data.it_code
--    và worker_profiles.fingerprint_code khi sửa/xét duyệt.
-- ----------------------------------------------------------------
ALTER TABLE daily_applications
  ADD COLUMN IF NOT EXISTS it_code varchar(40);

-- ----------------------------------------------------------------
-- 2) staging_daily_application.it_code — Import Engine v3 hỗ trợ cột "IT CODE"
--    khi import Daily Application từ file/bảng dán trực tiếp.
-- ----------------------------------------------------------------
ALTER TABLE staging_daily_application
  ADD COLUMN IF NOT EXISTS it_code text;

-- ----------------------------------------------------------------
-- 3) field_definitions — định nghĩa trường "da_it_code" cho Metadata Engine
--    (import/export/template/dán trực tiếp). Dành cho các DB ĐÃ seed trước đây;
--    DB mới sẽ tự seed qua DEFAULT_FIELD_DEFINITIONS trong code.
-- ----------------------------------------------------------------
INSERT INTO field_definitions (
  field_key, group_name, display_name, database_field,
  import_column_name, export_column_name, aliases,
  field_type, required, searchable, sortable, filterable, exportable, importable,
  sort_order, is_system
) VALUES (
  'da_it_code', 'daily_application', 'IT CODE', 'it_code',
  'IT CODE', 'IT CODE', '["IT Code", "Mã vân tay", "ITCODE"]',
  'TEXT', false, false, false, false, true, true,
  14, true
)
ON CONFLICT (field_key) DO NOTHING;
