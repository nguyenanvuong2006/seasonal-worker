-- ============================================================
-- SCHEMA.SQL — Dán TOÀN BỘ nội dung file này vào Neon SQL Editor
-- (Neon Console > SQL Editor > New query > Paste > Run) và chạy 1 lần
-- khi khởi tạo hệ thống. KHÔNG cần cài Node.js / drizzle-kit trên máy.
-- Phải khớp 100% với src/db/schema.ts — nếu sửa schema.ts thì cập nhật lại file này.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stt integer,
  dept_name varchar(120) NOT NULL,
  group_name varchar(120) NOT NULL DEFAULT '',
  vn_name varchar(200),
  supervisor varchar(160),
  supervisor_phone varchar(20),
  sheet_link text,
  daily_quota integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS dept_group_uq ON departments (dept_name, group_name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS dw_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(40),
  it_code varchar(40),
  old_dw_code varchar(60),
  id_vlookup varchar(40),
  full_name varchar(160) NOT NULL,
  gender varchar(8),
  bod varchar(20),
  profile varchar(120),
  dktn varchar(40),
  cccd varchar(20),
  date_of_issue varchar(20),
  place_of_issue varchar(160),
  permanent_address text,
  residential_address text,
  phone varchar(20),
  pit_of_dw varchar(40),
  note text,
  source varchar(120),
  sort_code integer,
  total_work_days integer NOT NULL DEFAULT 0,
  last_work_date date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  deleted_by varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS dw_cccd_uq ON dw_data (cccd) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS dw_name_idx ON dw_data (full_name);
CREATE INDEX IF NOT EXISTS dw_phone_idx ON dw_data (phone);

CREATE TABLE IF NOT EXISTS daily_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reg_date date NOT NULL,
  cccd varchar(20) NOT NULL,
  full_name varchar(160) NOT NULL,
  gender varchar(12),
  dob varchar(20),
  birth_year integer,
  age integer,
  phone varchar(20) NOT NULL,
  ethnicity varchar(60),
  permanent_address text,
  residential_address text,
  declared_type varchar(20) NOT NULL DEFAULT 'NEW',
  dw_match varchar(20) NOT NULL DEFAULT 'NEW',
  dw_id uuid REFERENCES dw_data(id) ON DELETE SET NULL,
  dw_code varchar(40),
  work_duration varchar(40),
  referral_channel varchar(120),
  dept_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  starting_date date,
  appointment_list varchar(60),
  note_worker text,
  vaccine varchar(60),
  code_check varchar(200),
  duplicate_name_flag boolean NOT NULL DEFAULT false,
  custom_answers jsonb DEFAULT '{}',
  is_imported boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  deleted_by varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS daily_app_cccd_date_uq ON daily_applications (cccd, reg_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS daily_app_date_status_idx ON daily_applications (reg_date, status);
CREATE INDEX IF NOT EXISTS daily_app_name_idx ON daily_applications (full_name);

CREATE TABLE IF NOT EXISTS form_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_key varchar(64) NOT NULL UNIQUE,
  question_text text NOT NULL,
  field_type varchar(24) NOT NULL DEFAULT 'TEXT',
  options jsonb DEFAULT '[]',
  is_required boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  apply_from date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(64) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name varchar(160) NOT NULL,
  role varchar(32) NOT NULL DEFAULT 'DEPT_MANAGER',
  dept_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  username varchar(64),
  action varchar(64) NOT NULL,
  target_type varchar(48),
  category varchar(24) NOT NULL DEFAULT 'AUDIT',
  details jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- CẬP NHẬT 2026-07-26 — METADATA ENGINE (Import/Export/Form động
-- không cần sửa code). Nếu database đã có sẵn dữ liệu cũ, chỉ cần
-- dán TOÀN BỘ file schema.sql này (kể cả các dòng CREATE TABLE ở
-- trên) vào Neon SQL Editor và bấm Run — mọi lệnh đều có IF NOT
-- EXISTS / ADD COLUMN IF NOT EXISTS nên chạy lại nhiều lần vẫn an
-- toàn, không mất dữ liệu hiện có.
-- ============================================================

ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS aliases jsonb DEFAULT '[]';
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS export_column_name varchar(160);

CREATE TABLE IF NOT EXISTS field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_key varchar(80) NOT NULL UNIQUE,
  group_name varchar(40) NOT NULL DEFAULT 'daily_application',
  display_name varchar(160) NOT NULL,
  database_field varchar(80) NOT NULL,
  import_column_name varchar(160),
  export_column_name varchar(160),
  aliases jsonb DEFAULT '[]',
  field_type varchar(24) NOT NULL DEFAULT 'TEXT',
  required boolean NOT NULL DEFAULT false,
  default_value text,
  visible boolean NOT NULL DEFAULT true,
  editable boolean NOT NULL DEFAULT true,
  searchable boolean NOT NULL DEFAULT false,
  sortable boolean NOT NULL DEFAULT false,
  filterable boolean NOT NULL DEFAULT false,
  exportable boolean NOT NULL DEFAULT true,
  importable boolean NOT NULL DEFAULT true,
  validation_rule text,
  apply_from date,
  sort_order integer NOT NULL DEFAULT 0,
  is_system boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- CẬP NHẬT 2026-07-26 (Giai đoạn 2) — SOFT DELETE + VERSIONING
-- Thêm cột deleted_at/deleted_by cho 3 bảng nghiệp vụ (Thùng rác / Recycle Bin
-- tại /admin/recycle-bin) và chuyển 3 unique index sang "partial index"
-- (WHERE deleted_at IS NULL) để cho phép đăng ký/nhập lại CCCD trùng với 1 hồ
-- sơ đã bị xoá mềm trước đó. Versioning (xem/khôi phục lịch sử) tái sử dụng
-- bảng audit_logs sẵn có — không cần bảng mới.
-- An toàn chạy lại nhiều lần, không mất dữ liệu hiện có.
-- ============================================================

ALTER TABLE departments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS deleted_by varchar(64);
ALTER TABLE dw_data ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE dw_data ADD COLUMN IF NOT EXISTS deleted_by varchar(64);
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS deleted_by varchar(64);

-- Chuyển 3 unique index sang partial (bỏ qua hồ sơ đã xoá mềm). Nếu index cũ
-- chưa phải partial (deploy trước 2026-07-26), lệnh DROP+CREATE dưới đây sẽ
-- thay thế bằng bản partial; nếu đã đúng rồi thì chạy lại cũng không sao.
DROP INDEX IF EXISTS dept_group_uq;
CREATE UNIQUE INDEX IF NOT EXISTS dept_group_uq ON departments (dept_name, group_name) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS dw_cccd_uq;
CREATE UNIQUE INDEX IF NOT EXISTS dw_cccd_uq ON dw_data (cccd) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS daily_app_cccd_date_uq;
CREATE UNIQUE INDEX IF NOT EXISTS daily_app_cccd_date_uq ON daily_applications (cccd, reg_date) WHERE deleted_at IS NULL;

-- ============================================================
-- CẬP NHẬT 2026-07-26 (Foundation Release) — Workflow Engine, Rule Engine,
-- RBAC chi tiết, Notification/Dashboard/Scheduler Foundation, Logging category.
-- An toàn chạy lại nhiều lần, không mất dữ liệu hiện có.
-- ============================================================

ALTER TABLE field_definitions ADD COLUMN IF NOT EXISTS filterable boolean NOT NULL DEFAULT false;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS category varchar(24) NOT NULL DEFAULT 'AUDIT';

CREATE TABLE IF NOT EXISTS workflow_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type varchar(40) NOT NULL DEFAULT 'daily_application',
  stage_key varchar(40) NOT NULL,
  label text NOT NULL,
  color varchar(16) NOT NULL DEFAULT 'gray',
  sort_order integer NOT NULL DEFAULT 0,
  is_start boolean NOT NULL DEFAULT false,
  is_end boolean NOT NULL DEFAULT false,
  allowed_roles jsonb DEFAULT '["ADMIN","HR_RECRUITER"]',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_stage_uq ON workflow_stages (entity_type, stage_key);

CREATE TABLE IF NOT EXISTS rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  entity_type varchar(40) NOT NULL DEFAULT 'daily_application',
  trigger varchar(40) NOT NULL DEFAULT 'ON_REGISTER',
  conditions jsonb DEFAULT '[]',
  actions jsonb DEFAULT '[]',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role varchar(32) NOT NULL,
  permission_key varchar(64) NOT NULL,
  allowed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS role_permission_uq ON role_permissions (role, permission_key);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event varchar(64) NOT NULL,
  recipient_type varchar(24) NOT NULL DEFAULT 'USER',
  recipient_ref varchar(160) NOT NULL,
  channel varchar(24) NOT NULL DEFAULT 'IN_APP',
  template_key varchar(64) NOT NULL,
  payload jsonb DEFAULT '{}',
  status varchar(20) NOT NULL DEFAULT 'QUEUED',
  scheduled_for timestamptz DEFAULT now(),
  sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(160) NOT NULL,
  widget_type varchar(24) NOT NULL DEFAULT 'KPI',
  data_source varchar(40) NOT NULL DEFAULT 'daily_applications',
  config jsonb DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key varchar(64) NOT NULL UNIQUE,
  label varchar(160) NOT NULL,
  schedule varchar(60) NOT NULL DEFAULT 'daily',
  handler_key varchar(64) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_status varchar(20),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- CẬP NHẬT 2026-07-26 (Foundation Release v2) — DIGITAL WORKER FILE (#10).
-- worker_profiles/employment_sessions là lớp TỔNG HỢP nằm trên daily_applications
-- (không thay thế, không đổi nghiệp vụ cũ). An toàn chạy lại nhiều lần.
-- ============================================================

CREATE TABLE IF NOT EXISTS worker_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cccd varchar(20) NOT NULL,
  full_name text NOT NULL,
  gender varchar(16),
  dob varchar(32),
  phone varchar(20),
  permanent_address text,
  residential_address text,
  dw_id uuid,
  fingerprint_code varchar(64),
  fingerprint_device varchar(64),
  fingerprint_status varchar(24) DEFAULT 'CHUA_CAP',
  fingerprint_created_at timestamptz,
  fingerprint_last_used_at timestamptz,
  deleted_at timestamptz,
  deleted_by varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_profile_cccd_uq ON worker_profiles (cccd) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS employment_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id uuid NOT NULL,
  daily_application_id uuid,
  dept_id uuid,
  reg_date date NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'PENDING',
  starting_date date,
  end_date date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS employment_session_daily_app_uq ON employment_sessions (daily_application_id) WHERE daily_application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS employment_session_worker_idx ON employment_sessions (worker_id);

-- Sau khi tạo bảng, vào /admin/worker-profiles bấm "Đồng bộ dữ liệu cũ" để tạo
-- worker_profiles + employment_sessions cho toàn bộ daily_applications đã có từ trước
-- (an toàn, chạy lại nhiều lần không tạo trùng — dùng CCCD làm khoá).

-- ============================================================
-- CẬP NHẬT 2026-07-27 (Phase 2 — Business Workflow Redesign)
-- RBAC + Data Scope, Workforce Movement (Nghỉ việc + Thuyên chuyển, 1 bảng
-- dùng chung theo xác nhận), Planning theo giai đoạn (thay dailyQuota).
-- KHÔNG xoá departments.daily_quota / dw_data.total_work_days / last_work_date
-- (deprecated, ngừng dùng ở code — xem HUONG_DAN_HE_THONG.md mục Refactor Plan
-- Step 7 — chỉ xoá vật lý ở 1 migration riêng sau khi xác nhận với người vận hành).
-- An toàn chạy lại nhiều lần.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_department_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_dept_scope_uq ON user_department_scopes (user_id, department_id);

CREATE TABLE IF NOT EXISTS workforce_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_type varchar(24) NOT NULL,
  worker_id uuid NOT NULL,
  from_dept_id uuid,
  to_dept_id uuid,
  effective_date date NOT NULL,
  reason text,
  note text,
  status varchar(40) NOT NULL DEFAULT 'PENDING_HR',
  related_movement_id uuid,
  requested_by varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workforce_movement_worker_idx ON workforce_movements (worker_id);
CREATE INDEX IF NOT EXISTS workforce_movement_status_idx ON workforce_movements (status);
CREATE INDEX IF NOT EXISTS workforce_movement_type_status_idx ON workforce_movements (movement_type, status);

CREATE TABLE IF NOT EXISTS planning_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  section varchar(120),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'DRAFT',
  version integer NOT NULL DEFAULT 1,
  superseded_by uuid,
  created_by varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS planning_active_dept_section_uq ON planning_periods (department_id, section) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS planning_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_period_id uuid NOT NULL REFERENCES planning_periods(id) ON DELETE CASCADE,
  target_count integer NOT NULL DEFAULT 0,
  note text
);

CREATE TABLE IF NOT EXISTS planning_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employment_session_id uuid NOT NULL,
  planning_period_id uuid NOT NULL,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  allocated_by varchar(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS planning_alloc_session_idx ON planning_allocations (employment_session_id);
CREATE INDEX IF NOT EXISTS planning_alloc_period_idx ON planning_allocations (planning_period_id);

-- Di trú 1 lần users.deptId (cột cũ, đơn) sang user_department_scopes (nhiều-nhiều) —
-- an toàn chạy lại nhiều lần (ON CONFLICT DO NOTHING theo unique index ở trên).
INSERT INTO user_department_scopes (user_id, department_id)
SELECT id, dept_id FROM users WHERE dept_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Xong. Mở lại website 1 lần để hệ thống tự nạp sẵn workflow_stages cho
-- resignation/transfer và scheduled_jobs mới (expire_planning_periods) nếu chưa có.

-- ============================================================
-- CẬP NHẬT 2026-07-27 (Import Engine v2 — Enterprise redesign)
-- Thay quy trình nhập dữ liệu cũ (parse toàn bộ ở trình duyệt, gửi nhiều lô nhỏ)
-- bằng: upload nguyên file -> bulk load vào staging -> merge theo lô (resumable,
-- transaction riêng từng lô, không timeout với file 30.000+ dòng).
-- An toàn chạy lại nhiều lần.
-- ============================================================

CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_type varchar(40) NOT NULL,
  file_name varchar(255) NOT NULL,
  total_rows integer NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'STAGED',
  column_mapping jsonb DEFAULT '{}',
  processed_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  started_by varchar(64) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS import_staging_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  row_number integer NOT NULL,
  raw_data jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING',
  message text
);
CREATE INDEX IF NOT EXISTS import_staging_batch_status_idx ON import_staging_rows (batch_id, status);

-- Xong. Sau khi chạy file này, /admin/import-data đã dùng kiến trúc mới —
-- upload file trực tiếp, không còn parse CSV/XLSX ở trình duyệt.

-- ============================================================
-- CẬP NHẬT 2026-07-28 (Import Engine v3 — Job-based Enterprise Architecture)
-- Thay HOÀN TOÀN kiến trúc "xử lý trong 1 request, client lặp gọi merge" bằng:
-- Job table + staging RIÊNG TỪNG LOẠI (không phải 1 bảng jsonb dùng chung) +
-- merge bằng SQL set-based (không vòng lặp SELECT/INSERT từng dòng) + worker
-- tự "chain" bằng Next.js after() (không cần trình duyệt giữ kết nối) +
-- Cron watchdog phục hồi Job treo. import_batches/import_staging_rows (bản
-- trước) không xoá (không có ý nghĩa nghiệp vụ dài hạn, an toàn bỏ không dùng).
-- An toàn chạy lại nhiều lần.
-- ============================================================

CREATE TABLE IF NOT EXISTS import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type varchar(40) NOT NULL,
  file_name varchar(255) NOT NULL,
  checksum varchar(64),
  status varchar(20) NOT NULL DEFAULT 'QUEUED',
  progress integer NOT NULL DEFAULT 0,
  current_stage varchar(30) NOT NULL DEFAULT 'STAGING',
  total_rows integer NOT NULL DEFAULT 0,
  processed_rows integer NOT NULL DEFAULT 0,
  inserted_rows integer NOT NULL DEFAULT 0,
  updated_rows integer NOT NULL DEFAULT 0,
  duplicate_rows integer NOT NULL DEFAULT 0,
  warning_rows integer NOT NULL DEFAULT 0,
  error_rows integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_by varchar(64) NOT NULL,
  resume_token uuid NOT NULL DEFAULT gen_random_uuid(),
  last_error text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_job_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  row_number integer NOT NULL,
  reason text NOT NULL,
  original_data jsonb NOT NULL,
  severity varchar(10) NOT NULL DEFAULT 'ERROR',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_job_errors_job_idx ON import_job_errors (job_id, severity);

CREATE TABLE IF NOT EXISTS staging_department (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  row_number integer NOT NULL,
  dept_stt integer,
  dept_name text,
  group_name text,
  vn_name text,
  supervisor text,
  supervisor_phone text,
  note text,
  valid boolean NOT NULL DEFAULT true,
  invalid_reason text
);
CREATE INDEX IF NOT EXISTS staging_department_job_idx ON staging_department (job_id, valid);

CREATE TABLE IF NOT EXISTS staging_dw_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  row_number integer NOT NULL,
  code text, it_code text, old_dw_code text, id_vlookup text, full_name text, gender text, bod text,
  profile text, dktn text, cccd text, date_of_issue text, place_of_issue text,
  permanent_address text, residential_address text, phone text,
  valid boolean NOT NULL DEFAULT true,
  invalid_reason text
);
CREATE INDEX IF NOT EXISTS staging_dw_data_job_idx ON staging_dw_data (job_id, valid);
CREATE INDEX IF NOT EXISTS staging_dw_data_cccd_idx ON staging_dw_data (job_id, cccd);

CREATE TABLE IF NOT EXISTS staging_daily_application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  row_number integer NOT NULL,
  cccd text, full_name text, gender text, dob text, age text, phone text, ethnicity text,
  permanent_address text, residential_address text, declared_type_raw text,
  dept_name text, group_name text, work_duration text, referral_channel text,
  starting_date_raw text, starting_date_parsed text, appointment_list text, note text, vaccine text, code_check text,
  reg_date_raw text, reg_date_parsed text, custom_answers jsonb DEFAULT '{}',
  resolved_dw_id uuid, resolved_dw_code text, resolved_dw_match varchar(10), resolved_dept_id uuid,
  valid boolean NOT NULL DEFAULT true,
  invalid_reason text
);
CREATE INDEX IF NOT EXISTS staging_daily_app_job_idx ON staging_daily_application (job_id, valid);
CREATE INDEX IF NOT EXISTS staging_daily_app_cccd_idx ON staging_daily_application (job_id, cccd);

-- Xong. /admin/import-data nay dùng Job-based Import Engine v3 — upload trả về
-- ngay jobId, xử lý chạy nền qua chuỗi tự "chain" (xem HUONG_DAN_HE_THONG.md mục 13).
-- Nhớ đặt biến môi trường CRON_SECRET trên Vercel (nếu chưa) để bảo vệ watchdog.

-- ============================================================
-- CẬP NHẬT 2026-07-28 (Import Audit — fix lỗi "invalid input syntax for type timestamp")
-- NGUYÊN NHÂN GỐC: giai đoạn MERGING nối chuỗi (reg_date_raw || 'T00:00:00+07:00') trực
-- tiếp trong SQL, không qua parser chuẩn hoá trước — dữ liệu dạng "dd/MM/yyyy HH:mm:ss"
-- (không phải ISO) làm hỏng chuỗi. FIX: thêm 2 cột "_parsed" lưu kết quả đã chuẩn hoá bằng
-- src/lib/date-parser.ts tại thời điểm staging — cột "_raw" giữ nguyên giá trị gốc (để báo
-- cáo lỗi hiển thị đúng dữ liệu người dùng đã nhập), MERGING chỉ cast từ cột "_parsed".
-- An toàn chạy lại nhiều lần.
-- ============================================================

ALTER TABLE staging_daily_application ADD COLUMN IF NOT EXISTS starting_date_parsed text;
ALTER TABLE staging_daily_application ADD COLUMN IF NOT EXISTS reg_date_parsed text;
