-- ============================================================
-- MIGRATION — 2026-08-13 — Branding, Profile & Global Search (UI Follow-up)
-- ============================================================
-- Chạy file này TRỰC TIẾP trên Neon SQL Editor (hoặc `psql -f`) trước khi deploy nhánh
-- claude/branding-profile-global-search lên Vercel.
--
-- An toàn:
--   * Idempotent — chạy lại nhiều lần không lỗi, không đổi kết quả (CREATE TABLE IF NOT EXISTS /
--     INSERT ... ON CONFLICT DO NOTHING).
--   * KHÔNG DROP bảng/cột nào, KHÔNG DELETE/UPDATE dữ liệu nghiệp vụ hiện có.
--   * Không phụ thuộc việc chạy lại schema.sql — độc lập hoàn toàn.
-- ============================================================

-- ----------------------------------------------------------------
-- 1) branding_settings — Year Theme + Year Slogan (Admin tự cấu hình, 1 dòng duy nhất)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branding_settings (
  id varchar(32) PRIMARY KEY DEFAULT 'default',
  year_theme_image text,
  year_slogan varchar(160),
  theme_year varchar(8),
  theme_subtitle varchar(160),
  updated_by varchar(64),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed đúng 1 dòng mặc định (rỗng) nếu chưa có — để GET/PATCH luôn có 1 dòng để update thay vì
-- phải tự xử lý "chưa tồn tại" ở tầng ứng dụng.
INSERT INTO branding_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;
