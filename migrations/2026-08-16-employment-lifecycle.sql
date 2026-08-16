-- ============================================================
-- EMPLOYMENT LIFECYCLE UPGRADE (2026-08-16)
-- ------------------------------------------------------------
-- Mục tiêu: employment_sessions + workforce_movements trở thành SOURCE OF TRUTH
-- của lịch sử làm việc; daily_applications CHỈ là lịch sử đăng ký/xin việc.
--
-- Nguyên tắc migration:
--   - ADDITIVE 100% — chỉ ADD COLUMN / CREATE TABLE / CREATE INDEX.
--   - KHÔNG DROP, KHÔNG UPDATE đè dữ liệu nghiệp vụ, KHÔNG chạy lại schema.sql.
--   - An toàn chạy lại nhiều lần (IF NOT EXISTS ở mọi lệnh).
--   - Partial unique index "1 worker = 1 ACTIVE session" CHỈ được tạo khi dữ liệu
--     hiện tại sạch — nếu còn worker có >1 ACTIVE session, migration KHÔNG fail,
--     KHÔNG tự sửa dữ liệu: nó ghi NOTICE + tạo view báo cáo để Admin đối soát
--     bằng Reconciliation Tool trước, rồi chạy lại migration.
--
-- ROLLBACK PLAN (chỉ khi thật sự cần — mọi thay đổi đều additive nên hệ cũ
-- vẫn chạy được nguyên trạng kể cả khi đã apply):
--   DROP INDEX IF EXISTS employment_session_one_active_uq;
--   DROP INDEX IF EXISTS workforce_movement_session_idx;
--   DROP TABLE IF EXISTS start_date_corrections;
--   DROP VIEW  IF EXISTS v_duplicate_active_employment;
--   ALTER TABLE employment_sessions
--     DROP COLUMN IF EXISTS end_reason, DROP COLUMN IF EXISTS ended_by,
--     DROP COLUMN IF EXISTS ended_at,   DROP COLUMN IF EXISTS end_movement_id,
--     DROP COLUMN IF EXISTS start_date_source;
--   ALTER TABLE workforce_movements
--     DROP COLUMN IF EXISTS employment_session_id, DROP COLUMN IF EXISTS confirmed_by,
--     DROP COLUMN IF EXISTS confirmed_at,          DROP COLUMN IF EXISTS source;
--   ALTER TABLE daily_applications
--     DROP COLUMN IF EXISTS worker_declared_previous_resignation,
--     DROP COLUMN IF EXISTS declared_previous_dept_id,
--     DROP COLUMN IF EXISTS declared_previous_session_id,
--     DROP COLUMN IF EXISTS declared_resignation_date,
--     DROP COLUMN IF EXISTS declared_resignation_note,
--     DROP COLUMN IF EXISTS declared_at;
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) employment_sessions — vòng đời kết thúc + nguồn gốc start date
-- ------------------------------------------------------------
ALTER TABLE employment_sessions ADD COLUMN IF NOT EXISTS end_reason varchar(40);
ALTER TABLE employment_sessions ADD COLUMN IF NOT EXISTS ended_by varchar(64);
ALTER TABLE employment_sessions ADD COLUMN IF NOT EXISTS ended_at timestamptz;
ALTER TABLE employment_sessions ADD COLUMN IF NOT EXISTS end_movement_id uuid;
ALTER TABLE employment_sessions ADD COLUMN IF NOT EXISTS start_date_source varchar(24) DEFAULT 'ASSIGNMENT';

-- ------------------------------------------------------------
-- 2) workforce_movements — truy vết session/confirm/source đầy đủ
-- ------------------------------------------------------------
ALTER TABLE workforce_movements ADD COLUMN IF NOT EXISTS employment_session_id uuid;
ALTER TABLE workforce_movements ADD COLUMN IF NOT EXISTS confirmed_by varchar(64);
ALTER TABLE workforce_movements ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE workforce_movements ADD COLUMN IF NOT EXISTS source varchar(32);
CREATE INDEX IF NOT EXISTS workforce_movement_session_idx ON workforce_movements (employment_session_id);

-- ------------------------------------------------------------
-- 3) daily_applications — self-declaration (chờ Recruiter xác minh,
--    KHÔNG tự đóng session / KHÔNG tự tạo resignation)
-- ------------------------------------------------------------
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS worker_declared_previous_resignation boolean NOT NULL DEFAULT false;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS declared_previous_dept_id uuid;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS declared_previous_session_id uuid;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS declared_resignation_date date;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS declared_resignation_note text;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS declared_at timestamptz;

-- ------------------------------------------------------------
-- 4) start_date_corrections — Recruiter yêu cầu, Admin duyệt (không backdate tuỳ ý)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS start_date_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employment_session_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  current_start_date date,
  requested_start_date date NOT NULL,
  reason text NOT NULL,
  note text,
  status varchar(32) NOT NULL DEFAULT 'PENDING_ADMIN_APPROVAL',
  requested_by varchar(64) NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by varchar(64),
  decided_at timestamptz,
  decision_note text,
  old_start_date date,
  new_start_date date
);
-- Idempotent: 1 session chỉ có 1 yêu cầu PENDING — cron/retry/double-click không tạo trùng.
CREATE UNIQUE INDEX IF NOT EXISTS start_date_correction_pending_uq
  ON start_date_corrections (employment_session_id) WHERE status = 'PENDING_ADMIN_APPROVAL';
CREATE INDEX IF NOT EXISTS start_date_correction_status_idx ON start_date_corrections (status);
CREATE INDEX IF NOT EXISTS start_date_correction_worker_idx ON start_date_corrections (worker_id);

-- ------------------------------------------------------------
-- 5) View báo cáo dữ liệu bẩn — Admin Reconciliation dùng, KHÔNG auto-fix.
--    ACTIVE := status = 'APPROVED' AND end_date IS NULL.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_duplicate_active_employment AS
SELECT worker_id, count(*) AS active_sessions, array_agg(id ORDER BY reg_date DESC) AS session_ids
FROM employment_sessions
WHERE status = 'APPROVED' AND end_date IS NULL
GROUP BY worker_id
HAVING count(*) > 1;

-- ------------------------------------------------------------
-- 6) INVARIANT cấp DB: 1 worker = tối đa 1 ACTIVE employment session.
--    Chỉ tạo khi dữ liệu sạch; nếu bẩn → NOTICE + để Admin đối soát trước.
-- ------------------------------------------------------------
DO $$
DECLARE
  dirty integer;
BEGIN
  SELECT count(*) INTO dirty FROM v_duplicate_active_employment;
  IF dirty > 0 THEN
    RAISE NOTICE 'EMPLOYMENT LIFECYCLE: % worker đang có >1 ACTIVE session — KHÔNG tạo employment_session_one_active_uq. Chạy scripts/audit-employment-data.mjs và dùng Admin Reconciliation (/admin/employment-reconciliation) để làm sạch, rồi chạy lại migration này.', dirty;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'employment_session_one_active_uq'
    ) THEN
      CREATE UNIQUE INDEX employment_session_one_active_uq
        ON employment_sessions (worker_id)
        WHERE status = 'APPROVED' AND end_date IS NULL;
    END IF;
  END IF;
END $$;

COMMIT;
