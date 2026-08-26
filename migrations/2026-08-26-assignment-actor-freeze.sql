-- ============================================================
-- MIGRATION — 2026-08-26 — ASSIGNMENT ACTOR FREEZE
-- ============================================================
-- Đóng băng "ai đã xếp việc" (non-APPROVED → APPROVED) vào:
--   daily_applications  +  employment_sessions
-- để placeholder `Nguoi_tiep_nhan` (Người tiếp nhận) trên tài liệu merge
-- hiển thị đúng người xếp việc thay vì người thực hiện thao tác merge.
--
-- An toàn:
--   * Idempotent — chạy lại nhiều lần không lỗi (ADD COLUMN IF NOT EXISTS).
--   * Chỉ THÊM cột nullable mới — KHÔNG DROP/đổi kiểu, KHÔNG UPDATE/DELETE
--     dữ liệu nghiệp vụ hiện có.
-- ============================================================

-- 1) daily_applications — assignment actor (nullable, chỉ ghi khi xếp việc thật).
ALTER TABLE daily_applications
  ADD COLUMN IF NOT EXISTS assigned_by varchar(64);

ALTER TABLE daily_applications
  ADD COLUMN IF NOT EXISTS assigned_by_display_name varchar(160);

ALTER TABLE daily_applications
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- 2) employment_sessions — assignment actor (nullable, đồng bộ với daily_applications).
ALTER TABLE employment_sessions
  ADD COLUMN IF NOT EXISTS assigned_by varchar(64);

ALTER TABLE employment_sessions
  ADD COLUMN IF NOT EXISTS assigned_by_display_name varchar(160);

ALTER TABLE employment_sessions
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
