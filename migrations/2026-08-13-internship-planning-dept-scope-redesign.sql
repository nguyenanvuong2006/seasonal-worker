-- ============================================================
-- MIGRATION — 2026-08-13 — Internship / Planning / Dept Scope Redesign
-- ============================================================
-- An toàn:
--   * Idempotent — chạy lại nhiều lần không lỗi, không đổi kết quả.
--   * KHÔNG DROP bảng/cột nào, KHÔNG DELETE dữ liệu nghiệp vụ.
--   * Dữ liệu cũ được giữ nguyên, backfill giá trị mặc định an toàn.
-- ============================================================

-- ----------------------------------------------------------------
-- 1) departments — Bổ sung cột phân cấp tổ chức (Location -> Division -> Department -> Section -> Group)
-- ----------------------------------------------------------------
ALTER TABLE departments ADD COLUMN IF NOT EXISTS location varchar(120) DEFAULT '';
ALTER TABLE departments ADD COLUMN IF NOT EXISTS division varchar(120) DEFAULT '';
ALTER TABLE departments ADD COLUMN IF NOT EXISTS section varchar(120) DEFAULT '';

-- ----------------------------------------------------------------
-- 2) planning_periods — Cho phép trùng thời gian + bổ sung request_type & supplement_index
-- ----------------------------------------------------------------
-- Huỷ index unique cũ chặn trùng thời gian cùng dept+section
DROP INDEX IF EXISTS planning_active_dept_section_uq;

ALTER TABLE planning_periods ADD COLUMN IF NOT EXISTS request_type varchar(24) NOT NULL DEFAULT 'ORIGINAL';
ALTER TABLE planning_periods ADD COLUMN IF NOT EXISTS supplement_index integer NOT NULL DEFAULT 0;
ALTER TABLE planning_periods ADD COLUMN IF NOT EXISTS parent_period_id uuid REFERENCES planning_periods(id) ON DELETE SET NULL;
ALTER TABLE planning_periods ADD COLUMN IF NOT EXISTS location varchar(120);
ALTER TABLE planning_periods ADD COLUMN IF NOT EXISTS division varchar(120);
ALTER TABLE planning_periods ADD COLUMN IF NOT EXISTS group_name varchar(120);

CREATE INDEX IF NOT EXISTS planning_dept_status_idx ON planning_periods (department_id, status);
CREATE INDEX IF NOT EXISTS planning_parent_idx ON planning_periods (parent_period_id);

-- ----------------------------------------------------------------
-- 3) planning_targets — Phân tách nhu cầu Nam / Nữ
-- ----------------------------------------------------------------
ALTER TABLE planning_targets ADD COLUMN IF NOT EXISTS demand_male integer NOT NULL DEFAULT 0;
ALTER TABLE planning_targets ADD COLUMN IF NOT EXISTS demand_female integer NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------
-- 4) planning_allocations — Index tra cứu nhanh
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS planning_alloc_session_idx ON planning_allocations (employment_session_id);
CREATE INDEX IF NOT EXISTS planning_alloc_period_idx ON planning_allocations (planning_period_id);
CREATE UNIQUE INDEX IF NOT EXISTS planning_alloc_session_period_uq ON planning_allocations (employment_session_id, planning_period_id);

-- ============================================================
-- Xong migration.
-- ============================================================
