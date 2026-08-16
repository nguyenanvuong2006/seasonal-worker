-- ============================================================================
-- 2026-08-17 — PLANNING / WORKFORCE RECRUITMENT REQUEST UPGRADE
-- ----------------------------------------------------------------------------
-- Nâng cấp module Planning (Nhu cầu) theo quy trình Workforce Recruitment
-- Request của Dalat Hasfarm.
--
-- NGUYÊN TẮC AN TOÀN:
--   * KHÔNG chạy lại schema.sql.
--   * KHÔNG DROP / DELETE bất kỳ dữ liệu lịch sử nào.
--   * KHÔNG đổi tên bảng cũ: planning_periods, planning_targets,
--     planning_allocations được GIỮ NGUYÊN và chỉ được MỞ RỘNG.
--   * Toàn bộ script idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING) —
--     chạy lại nhiều lần vẫn an toàn.
--
-- THỨ TỰ TRIỂN KHAI: chạy file này TRƯỚC khi deploy code mới.
--   Mọi cột thêm mới đều NULLable hoặc có DEFAULT nên code CŨ vẫn chạy được
--   sau khi migrate (backward compatible → deploy không cần downtime).
-- ============================================================================

BEGIN;

-- ============================================================================
-- PHẦN 1 — recruitment_requests: chuẩn hoá & bổ sung cột còn thiếu
-- ============================================================================

-- 1.1 Sáu trường ngày TÁCH BIỆT (Yêu cầu #6).
--     requested_date / expected_date / offered_date / completed_date đã có từ
--     migration 2026-08-16; bổ sung starting_date và end_date.
ALTER TABLE recruitment_requests ADD COLUMN IF NOT EXISTS starting_date date;
ALTER TABLE recruitment_requests ADD COLUMN IF NOT EXISTS end_date       date;

COMMENT ON COLUMN recruitment_requests.requested_date IS 'Ngày yêu cầu — ngày bộ phận gửi yêu cầu tuyển dụng.';
COMMENT ON COLUMN recruitment_requests.expected_date  IS 'Ngày cần nhân lực — mốc sắp xếp MẶC ĐỊNH của bảng Planning.';
COMMENT ON COLUMN recruitment_requests.starting_date  IS 'Ngày nhận việc — ngày DW bắt đầu làm việc thực tế.';
COMMENT ON COLUMN recruitment_requests.end_date       IS 'Ngày kết thúc yêu cầu — quá ngày này yêu cầu HẾT HẠN (EXPIRED), KHÔNG phải huỷ và KHÔNG phải DW nghỉ việc.';
COMMENT ON COLUMN recruitment_requests.offered_date   IS 'Ngày đề nghị (Offered Date) — chuẩn hoá 1 tên duy nhất, không dùng biến thể "Offerred Date".';
COMMENT ON COLUMN recruitment_requests.completed_date IS 'Ngày tuyển đủ.';

-- 1.2 Chỉ số chênh lệch ngày (Yêu cầu #1) — hệ thống tự tính, đơn vị NGÀY.
ALTER TABLE recruitment_requests ADD COLUMN IF NOT EXISTS offered_vs_requested   integer;
ALTER TABLE recruitment_requests ADD COLUMN IF NOT EXISTS completed_vs_requested integer;

COMMENT ON COLUMN recruitment_requests.offered_vs_requested   IS 'DERIVED: offered_date - requested_date (số ngày).';
COMMENT ON COLUMN recruitment_requests.completed_vs_requested IS 'DERIVED: completed_date - requested_date (số ngày).';

-- 1.3 Sửa lệch kiểu dữ liệu giữa SQL và Drizzle (cost, recruited_vs_expected).
--     Cả hai được chuẩn hoá về integer để khớp model TypeScript.
--     numeric -> integer làm tròn, không mất bản ghi.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'recruitment_requests' AND column_name = 'cost'
      AND data_type = 'numeric'
  ) THEN
    ALTER TABLE recruitment_requests
      ALTER COLUMN cost TYPE integer USING ROUND(COALESCE(cost, 0))::integer;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'recruitment_requests' AND column_name = 'recruited_vs_expected'
      AND data_type = 'numeric'
  ) THEN
    ALTER TABLE recruitment_requests
      ALTER COLUMN recruited_vs_expected TYPE integer USING ROUND(COALESCE(recruited_vs_expected, 0))::integer;
  END IF;
END $$;

COMMENT ON COLUMN recruitment_requests.recruited_vs_expected IS 'DERIVED: phần trăm hoàn thành = round(recruited / total_request * 100).';

-- 1.4 Liên kết CỨNG tới departments (Yêu cầu #15).
--     Trước đây scope Data Scope so khớp UUID phòng ban với cột text
--     recruitment_requests.department → luôn sai. Thêm FK thật để lọc đúng.
ALTER TABLE recruitment_requests
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;

COMMENT ON COLUMN recruitment_requests.department_id IS 'FK tới departments.id — khoá lọc Data Scope phía server. Cột text `department` chỉ để hiển thị/import.';

CREATE INDEX IF NOT EXISTS recruitment_requests_department_id_idx
  ON recruitment_requests (department_id);

-- 1.5 Chuỗi lịch sử append-only (Yêu cầu #4).
ALTER TABLE recruitment_requests
  ADD COLUMN IF NOT EXISTS previous_request_id   uuid REFERENCES recruitment_requests(id) ON DELETE SET NULL;
ALTER TABLE recruitment_requests
  ADD COLUMN IF NOT EXISTS supersedes_request_id uuid REFERENCES recruitment_requests(id) ON DELETE SET NULL;

COMMENT ON COLUMN recruitment_requests.previous_request_id   IS 'Append-only: yêu cầu liền trước trong cùng chuỗi lịch sử.';
COMMENT ON COLUMN recruitment_requests.supersedes_request_id IS 'Append-only: yêu cầu cũ mà bản ghi này thay thế. Bản cũ KHÔNG bị xoá/ghi đè.';

CREATE INDEX IF NOT EXISTS recruitment_requests_previous_idx   ON recruitment_requests (previous_request_id);
CREATE INDEX IF NOT EXISTS recruitment_requests_supersedes_idx ON recruitment_requests (supersedes_request_id);

-- 1.6 Index phục vụ SORT MẶC ĐỊNH theo Expected Date (Yêu cầu #5).
CREATE INDEX IF NOT EXISTS recruitment_requests_expected_date_idx
  ON recruitment_requests (expected_date NULLS LAST)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS recruitment_requests_end_date_idx
  ON recruitment_requests (end_date)
  WHERE deleted_at IS NULL;

-- 1.7 Trạng thái EXPIRED tách biệt với CANCELLED (Yêu cầu #13).
--     Hết hạn KHÔNG bao giờ tự động thành CANCELLED.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recruitment_requests_status_chk'
  ) THEN
    ALTER TABLE recruitment_requests
      ADD CONSTRAINT recruitment_requests_status_chk
      CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'EXPIRED'));
  END IF;
END $$;

-- ============================================================================
-- PHẦN 2 — planning_allocations: lịch sử phân bổ (Yêu cầu #8)
-- ----------------------------------------------------------------------------
-- Bảng cũ chỉ lưu "phân bổ hiện tại" (unique employment_session_id +
-- planning_period_id). Bổ sung vòng đời để CHUYỂN phân bổ mà KHÔNG mất lịch sử.
-- ============================================================================

ALTER TABLE planning_allocations ADD COLUMN IF NOT EXISTS allocation_start_date  date;
ALTER TABLE planning_allocations ADD COLUMN IF NOT EXISTS allocation_end_date    date;
ALTER TABLE planning_allocations ADD COLUMN IF NOT EXISTS previous_allocation_id uuid REFERENCES planning_allocations(id) ON DELETE SET NULL;
ALTER TABLE planning_allocations ADD COLUMN IF NOT EXISTS reallocated_by         varchar(64);
ALTER TABLE planning_allocations ADD COLUMN IF NOT EXISTS reallocated_at         timestamptz;
ALTER TABLE planning_allocations ADD COLUMN IF NOT EXISTS recruitment_request_id uuid REFERENCES recruitment_requests(id) ON DELETE SET NULL;

COMMENT ON COLUMN planning_allocations.allocation_start_date  IS 'Ngày bắt đầu hiệu lực của phân bổ này.';
COMMENT ON COLUMN planning_allocations.allocation_end_date    IS 'Ngày kết thúc phân bổ. KHÁC HOÀN TOÀN với nghỉ việc: đóng phân bổ KHÔNG làm DW nghỉ việc.';
COMMENT ON COLUMN planning_allocations.previous_allocation_id IS 'Trỏ về phân bổ cũ khi tái phân bổ — giữ nguyên chuỗi truy vết.';
COMMENT ON COLUMN planning_allocations.reallocated_by         IS 'Ai thực hiện tái phân bổ.';
COMMENT ON COLUMN planning_allocations.reallocated_at         IS 'Thời điểm tái phân bổ.';
COMMENT ON COLUMN planning_allocations.recruitment_request_id IS 'Yêu cầu tuyển dụng mà phân bổ này phục vụ (nếu có).';

-- Phân bổ cũ chưa có ngày bắt đầu → lấy theo allocated_at (không mất dữ liệu).
UPDATE planning_allocations
   SET allocation_start_date = allocated_at::date
 WHERE allocation_start_date IS NULL;

-- Ràng buộc unique CŨ (employment_session_id, planning_period_id) chặn việc
-- một DW quay lại kế hoạch cũ sau này. Thay bằng unique PARTIAL chỉ áp dụng
-- cho phân bổ ĐANG HIỆU LỰC → mỗi DW chỉ có 1 phân bổ mở trên 1 kế hoạch,
-- nhưng lịch sử các phân bổ đã đóng vẫn được lưu đầy đủ.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'planning_allocations'::regclass
       AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE planning_allocations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

DROP INDEX IF EXISTS planning_alloc_session_period_uq;

CREATE UNIQUE INDEX IF NOT EXISTS planning_alloc_active_uq
  ON planning_allocations (employment_session_id, planning_period_id)
  WHERE allocation_end_date IS NULL;

CREATE INDEX IF NOT EXISTS planning_alloc_open_idx
  ON planning_allocations (planning_period_id)
  WHERE allocation_end_date IS NULL;

CREATE INDEX IF NOT EXISTS planning_alloc_request_idx
  ON planning_allocations (recruitment_request_id);

-- ============================================================================
-- PHẦN 3 — planning_column_configs: cấu hình cột do Admin quản lý (Yêu cầu #2)
-- ----------------------------------------------------------------------------
-- KHÔNG hardcode danh sách cột trong UI, KHÔNG chỉ lưu localStorage.
-- ============================================================================

CREATE TABLE IF NOT EXISTS planning_column_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role        varchar(32)  NOT NULL,
  device      varchar(16)  NOT NULL DEFAULT 'desktop',
  column_key  varchar(64)  NOT NULL,
  visible     boolean      NOT NULL DEFAULT true,
  sticky      boolean      NOT NULL DEFAULT false,
  sort_order  integer      NOT NULL DEFAULT 0,
  updated_by  varchar(64),
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT planning_column_configs_device_chk CHECK (device IN ('desktop', 'mobile'))
);

CREATE UNIQUE INDEX IF NOT EXISTS planning_column_configs_uq
  ON planning_column_configs (role, device, column_key);

CREATE INDEX IF NOT EXISTS planning_column_configs_role_idx
  ON planning_column_configs (role, device);

COMMENT ON TABLE planning_column_configs IS
  'Cấu hình cột bảng Planning theo VAI TRÒ và THIẾT BỊ. Nguồn cột lấy từ catalog code (recruitment-request-columns.ts); bảng này chỉ lưu bật/tắt, thứ tự, ghim.';

-- ============================================================================
-- PHẦN 4 — planning_tasks: Task Center bền vững (Yêu cầu #7 & #14)
-- ----------------------------------------------------------------------------
-- Task Center hiện tại là aggregator truy vấn trực tiếp, không lưu bảng nên
-- không thể "auto DONE" hay chống trùng khi cron chạy lại. Thêm bảng task thật.
-- ============================================================================

CREATE TABLE IF NOT EXISTS planning_tasks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type              varchar(48) NOT NULL,
  status                 varchar(24) NOT NULL DEFAULT 'OPEN',
  recruitment_request_id uuid REFERENCES recruitment_requests(id) ON DELETE CASCADE,
  planning_period_id     uuid REFERENCES planning_periods(id)     ON DELETE CASCADE,
  department_id          uuid REFERENCES departments(id)          ON DELETE SET NULL,
  title                  text        NOT NULL,
  detail                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  due_date               date,
  resolved_at            timestamptz,
  resolved_by            varchar(64),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planning_tasks_status_chk CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE', 'DISMISSED'))
);

-- CHỐNG TRÙNG (Yêu cầu #14): cron / retry chạy bao nhiêu lần cũng chỉ tạo 1 task
-- đang mở cho mỗi (task_type, recruitment_request_id).
CREATE UNIQUE INDEX IF NOT EXISTS planning_tasks_open_uq
  ON planning_tasks (task_type, recruitment_request_id)
  WHERE status IN ('OPEN', 'IN_PROGRESS');

CREATE INDEX IF NOT EXISTS planning_tasks_status_idx ON planning_tasks (status, task_type);
CREATE INDEX IF NOT EXISTS planning_tasks_dept_idx   ON planning_tasks (department_id);

COMMENT ON TABLE planning_tasks IS
  'Task Center bền vững cho Planning. PLANNING_REALLOCATION_REQUIRED: yêu cầu hết hạn nhưng vẫn còn DW đang được phân bổ — Recruiter phải chuyển phân bổ sang yêu cầu mới. KHÔNG BAO GIỜ tự tạo nghỉ việc.';

-- ============================================================================
-- PHẦN 5 — Quyền mới (Yêu cầu #3 & #11)
-- ============================================================================
-- Catalog quyền (bảng `permissions`: key / name / group_name / description).
INSERT INTO permissions (key, name, group_name, description, is_system)
VALUES
  ('planning.reallocate',     'Chuyển phân bổ DW sang yêu cầu khác', 'planning', 'Tái phân bổ DW từ yêu cầu tuyển dụng hết hạn sang yêu cầu mới. Không tạo nghỉ việc.', true),
  ('planning.columns.manage', 'Cấu hình cột bảng Planning',          'planning', 'Bật/tắt, sắp xếp, ghim cột bảng Planning theo vai trò và thiết bị.', true),
  ('planning.comment',        'Bình luận / ghi chú yêu cầu',         'planning', 'Thêm ghi chú vào yêu cầu tuyển dụng. KHÔNG làm thay đổi số liệu nguồn.', true)
ON CONFLICT (key) DO NOTHING;

-- Gán quyền theo vai trò (bảng `role_permissions`: role / permission_key / allowed).
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('ADMIN',        'planning.reallocate',     true),
  ('ADMIN',        'planning.columns.manage', true),
  ('ADMIN',        'planning.comment',        true),
  ('HR_RECRUITER', 'planning.reallocate',     true),
  ('HR_RECRUITER', 'planning.comment',        true),
  -- DEPT_MANAGER: chỉ được BÌNH LUẬN, tuyệt đối không import / sửa / tái phân bổ.
  ('DEPT_MANAGER', 'planning.comment',        true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- SỬA LỖI PHÂN QUYỀN: DEPT_MANAGER không được phép TẠO yêu cầu tuyển dụng
-- (chỉ đọc trong phạm vi Data Scope — Yêu cầu #3). Thu hồi bằng cách đặt
-- allowed = false (giữ bản ghi để còn vết, không DELETE dữ liệu).
INSERT INTO role_permissions (role, permission_key, allowed)
VALUES ('DEPT_MANAGER', 'planning.request', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = false;

INSERT INTO role_permissions (role, permission_key, allowed)
VALUES ('DEPT_MANAGER', 'planning.import', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = false;

-- ============================================================================
-- PHẦN 6 — Job scheduler quét yêu cầu hết hạn (Yêu cầu #7 & #14)
-- ============================================================================
INSERT INTO scheduled_jobs (job_key, label, schedule, handler_key, is_active)
VALUES (
  'expire_recruitment_requests',
  'Quét yêu cầu tuyển dụng hết hạn & tạo Task tái phân bổ',
  'daily',
  'EXPIRE_RECRUITMENT_REQUESTS',
  true
)
ON CONFLICT (job_key) DO NOTHING;

-- ============================================================================
-- PHẦN 7 — Backfill department_id từ cột text (an toàn, không ghi đè)
-- ----------------------------------------------------------------------------
-- Chỉ điền cho bản ghi CHƯA có department_id và khớp DUY NHẤT 1 phòng ban.
-- Bản ghi không khớp được giữ nguyên NULL để HR đối chiếu thủ công.
-- ============================================================================
UPDATE recruitment_requests rr
   SET department_id = d.id
  FROM departments d
 WHERE rr.department_id IS NULL
   AND rr.department IS NOT NULL
   AND d.deleted_at IS NULL
   AND lower(btrim(d.dept_name)) = lower(btrim(rr.department))
   AND (
     SELECT count(*) FROM departments d2
      WHERE d2.deleted_at IS NULL
        AND lower(btrim(d2.dept_name)) = lower(btrim(rr.department))
   ) = 1;

COMMIT;

-- ============================================================================
-- ROLLBACK (chạy thủ công nếu cần quay lui — KHÔNG xoá dữ liệu nghiệp vụ)
-- ----------------------------------------------------------------------------
-- BEGIN;
--   DROP INDEX IF EXISTS planning_alloc_active_uq;
--   CREATE UNIQUE INDEX planning_alloc_session_period_uq
--     ON planning_allocations (employment_session_id, planning_period_id);
--   DROP TABLE IF EXISTS planning_tasks;
--   DROP TABLE IF EXISTS planning_column_configs;
--   ALTER TABLE recruitment_requests DROP CONSTRAINT IF EXISTS recruitment_requests_status_chk;
--   DELETE FROM scheduled_jobs WHERE job_key = 'expire_recruitment_requests';
--   -- Các cột thêm mới đều NULLable: có thể GIỮ LẠI an toàn khi rollback code.
--   -- Chỉ xoá nếu chắc chắn không cần dữ liệu tái phân bổ:
--   -- ALTER TABLE planning_allocations
--   --   DROP COLUMN IF EXISTS allocation_start_date,
--   --   DROP COLUMN IF EXISTS allocation_end_date,
--   --   DROP COLUMN IF EXISTS previous_allocation_id,
--   --   DROP COLUMN IF EXISTS reallocated_by,
--   --   DROP COLUMN IF EXISTS reallocated_at,
--   --   DROP COLUMN IF EXISTS recruitment_request_id;
-- COMMIT;
