-- ============================================================
-- MIGRATION — 2026-08-16 — Workforce Request ↔ Planning ↔ Employment/Allocation
-- ============================================================
-- Kiến trúc liên kết: Workforce Request (recruitment_requests) là nơi lưu
-- NHU CẦU; Planning (planning_periods/planning_targets) theo dõi mức đáp ứng
-- của từng Request; Employment Session là source of truth người ACTIVE;
-- request_allocations xác định 1 ACTIVE worker đang được tính vào request nào.
--
-- An toàn (mục 18):
--   * Additive + idempotent — chạy lại nhiều lần không lỗi
--     (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
--      CREATE INDEX IF NOT EXISTS).
--   * KHÔNG DROP, KHÔNG đổi kiểu, KHÔNG DELETE/UPDATE dữ liệu
--     planning_periods / planning_targets / planning_allocations hiện có.
-- ============================================================

-- ----------------------------------------------------------------
-- 1) LIÊN KẾT ID (mục 8) — không match bằng text Department/Date
-- ----------------------------------------------------------------
-- 1a. Request → Department (cấu trúc, phục vụ Data Scope). Cột text `department`
--     vẫn giữ nguyên làm fallback/back-compat — không xoá.
ALTER TABLE recruitment_requests
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS recruitment_requests_dept_id_idx
  ON recruitment_requests (department_id);

-- 1b. Planning Period → Workforce Request (FK ngược của recruitment_requests.planning_period_id).
--     Migration 2026-08-16-recruitment-requests.sql đã thêm planning_periods.request_code (text)
--     làm phương án matching cũ; cột request_id dưới đây là liên kết chuẩn — code ưu tiên ID.
ALTER TABLE planning_periods
  ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES recruitment_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS planning_request_idx ON planning_periods (request_id);

-- 1c. Daily Application → Workforce Request (pipeline Application/Screened/
--     Interviewed/Recruited tính theo Workflow, không dùng số import tay).
ALTER TABLE daily_applications
  ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES recruitment_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS daily_app_request_idx ON daily_applications (request_id);

-- ----------------------------------------------------------------
-- 2) REQUEST ALLOCATION (mục 1 + 4)
--    "1 ACTIVE worker đang được tính vào Workforce Request nào"
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employment_session_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  request_id uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | ENDED
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  allocated_by varchar(64) NOT NULL,
  ended_by varchar(64),
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- CHỐT DB (mục 4): 1 worker tối đa 1 ACTIVE request allocation tại 1 thời điểm.
-- Lớp cuối chống double-click/race sau khi transaction đã kiểm tra logic.
CREATE UNIQUE INDEX IF NOT EXISTS request_alloc_one_active_per_worker_uq
  ON request_allocations (worker_id) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS request_alloc_request_status_idx
  ON request_allocations (request_id, status);
CREATE INDEX IF NOT EXISTS request_alloc_session_idx
  ON request_allocations (employment_session_id);
CREATE INDEX IF NOT EXISTS request_alloc_worker_idx
  ON request_allocations (worker_id);

-- ----------------------------------------------------------------
-- 3) ALLOCATION HISTORY (mục 15) — audit mọi thay đổi allocation
--    worker_id / from_request_id / to_request_id / changed_by /
--    changed_at / reason. Cột request_id là request liên quan
--    (to trước, from nếu END) để lọc nhanh theo request.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_allocation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  employment_session_id uuid,
  from_request_id uuid,
  to_request_id uuid,
  action varchar(24) NOT NULL, -- ALLOCATE | REALLOCATE | END | OVERRIDE
  reason text,
  override_confirmed boolean NOT NULL DEFAULT false,
  changed_by varchar(64) NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS request_alloc_history_request_idx
  ON request_allocation_history (request_id, changed_at);
CREATE INDEX IF NOT EXISTS request_alloc_history_worker_idx
  ON request_allocation_history (worker_id, changed_at);
CREATE INDEX IF NOT EXISTS request_alloc_history_from_idx
  ON request_allocation_history (from_request_id);
CREATE INDEX IF NOT EXISTS request_alloc_history_to_idx
  ON request_allocation_history (to_request_id);

-- ----------------------------------------------------------------
-- 4) OVERRIDE LOG (mục 6 + 15) — override vượt tổng nhu cầu log RIÊNG
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_allocation_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  changed_by varchar(64) NOT NULL,
  reason text NOT NULL,
  confirmed boolean NOT NULL DEFAULT true,
  current_total integer NOT NULL DEFAULT 0,
  total_request integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS request_override_request_idx
  ON request_allocation_overrides (request_id, created_at);

-- ----------------------------------------------------------------
-- 5) REQUEST COMMENTS (mục 11) — Dept Manager READ + bình luận
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  user_id uuid,
  username varchar(64) NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS request_comment_request_idx
  ON request_comments (request_id, created_at);

-- ----------------------------------------------------------------
-- 6) KPI CACHE (mục 9) — cache có timestamp + recompute job; KHÔNG
--    phải source of truth (source of truth là query từ dữ liệu gốc).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_kpi_cache (
  request_id uuid PRIMARY KEY,
  as_of_date date NOT NULL,
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS request_kpi_cache_computed_idx
  ON request_kpi_cache (computed_at);
