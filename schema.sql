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
  location varchar(120) DEFAULT '',
  division varchar(120) DEFAULT '',
  dept_name varchar(120) NOT NULL,
  section varchar(120) DEFAULT '',
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
  cccd varchar(20) NOT NULL,
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
  visible_to_applicants boolean NOT NULL DEFAULT true,
  target_audience varchar(20) NOT NULL DEFAULT 'ALL' CONSTRAINT form_questions_target_audience_chk CHECK (target_audience IN ('ALL', 'NEW_ONLY', 'RETURNING_ONLY')),
  skip_for_returning boolean NOT NULL DEFAULT false,
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

-- ============================================================================
-- DYNAMIC RBAC V2 — catalog ROLE / PERMISSION (xem migrations/2026-08-14-dynamic-rbac-v2.sql)
-- Additive + idempotent. users.role (varchar) giữ nguyên là role key.
-- ============================================================================
CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(32) NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_key_uq ON roles (key);

CREATE TABLE IF NOT EXISTS permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(64) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  group_name varchar(40) NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS permissions_key_uq ON permissions (key);

INSERT INTO roles (key, name, description, is_system, is_active, sort_order) VALUES
  ('ADMIN',         'Quản trị viên hệ thống', 'Toàn quyền hệ thống (bypass mọi kiểm tra quyền).', true, true, 1),
  ('HR_RECRUITER',  'Nhân sự tuyển dụng',     'Vận hành tuyển dụng: tiếp nhận/duyệt hồ sơ, DW Data, Hồ sơ Tập nghề, Planning, Nghỉ việc/Thuyên chuyển.', true, true, 2),
  ('DEPT_MANAGER',  'Quản lý bộ phận',        'Chỉ thao tác trong Data Scope được gán: xem hồ sơ APPROVED, tạo yêu cầu Planning (DRAFT), Nghỉ việc/Thuyên chuyển.', true, true, 3),
  ('HR_DIRECTOR',   'Giám đốc Nhân sự',       'Quyền nghiệp vụ cấp cao: xem hồ sơ/Planning/Nghỉ việc/Xuất Excel/Nhật ký — KHÔNG quản lý users/RBAC/Data Scope/Backup/Branding/Health.', false, true, 4)
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key, name, group_name, is_system) VALUES
  ('registrations.view', 'Xem Daily Application', 'tuyendung', true),
  ('registrations.edit', 'Sửa Daily Application', 'tuyendung', true),
  ('registrations.approve', 'Duyệt / Từ chối hồ sơ', 'tuyendung', true),
  ('registrations.export', 'Xuất Excel', 'tuyendung', true),
  ('questions.manage', 'Quản lý Câu hỏi động (Form Builder)', 'cau_hoi_dong', true),
  ('dw.view', 'Xem DW Data', 'dw_data', true),
  ('dw.edit', 'Sửa DW Data', 'dw_data', true),
  ('dw.delete', 'Xoá DW Data', 'dw_data', true),
  ('worker_profile.view', 'Xem Hồ sơ Tập nghề', 'ho_so_tap_nghe', true),
  ('worker_profile.edit', 'Sửa Hồ sơ Tập nghề', 'ho_so_tap_nghe', true),
  ('departments.manage', 'Quản lý Cơ cấu tổ chức', 'co_cau_to_chuc', true),
  ('planning.view', 'Xem Planning', 'planning', true),
  ('planning.request', 'Tạo yêu cầu Planning (DRAFT)', 'planning', true),
  ('planning.edit', 'Sửa Planning (revise)', 'planning', true),
  ('planning.activate', 'Kích hoạt Planning', 'planning', true),
  ('workforce_movements.view', 'Xem yêu cầu Nghỉ việc / Thuyên chuyển', 'nghi_viec_thuyen_chuyen', true),
  ('workforce_movements.create', 'Tạo yêu cầu Nghỉ việc / Thuyên chuyển', 'nghi_viec_thuyen_chuyen', true),
  ('workforce_movements.manage', 'HR xử lý yêu cầu Nghỉ việc / Thuyên chuyển', 'nghi_viec_thuyen_chuyen', true),
  ('history.view', 'Xem Lịch sử phiên bản', 'lich_su', true),
  ('history.restore', 'Khôi phục phiên bản cũ', 'lich_su', true),
  ('recycle_bin.manage', 'Quản lý Thùng rác', 'lich_su', true),
  ('import.run', 'Nhập dữ liệu (Import)', 'du_lieu', true),
  ('field_definitions.manage', 'Quản lý Trường dữ liệu (Metadata)', 'du_lieu', true),
  ('users.view', 'Xem danh sách người dùng', 'nguoi_dung', true),
  ('users.manage', 'Quản lý tài khoản (tạo/sửa/khoá)', 'nguoi_dung', true),
  ('data_scope.view', 'Xem cấu hình Data Scope', 'data_scope', true),
  ('data_scope.manage', 'Gán / gỡ Data Scope', 'data_scope', true),
  ('rbac.view', 'Xem cấu hình Phân quyền', 'rbac', true),
  ('rbac.manage', 'Quản lý Vai trò & Phân quyền', 'rbac', true),
  ('audit.view', 'Xem Nhật ký hệ thống (Audit Log)', 'rbac', true),
  ('workflow.manage', 'Quản lý Workflow', 'cau_hinh_van_hanh', true),
  ('rules.manage', 'Quản lý Rule Engine', 'cau_hinh_van_hanh', true),
  ('notifications.manage', 'Quản lý hàng đợi Thông báo', 'cau_hinh_van_hanh', true),
  ('branding.manage', 'Quản lý Thương hiệu & Chủ đề năm', 'cau_hinh_van_hanh', true),
  ('system.view', 'Xem Health Monitor / Control Center', 'cau_hinh_van_hanh', true),
  ('backup.manage', 'Backup dữ liệu', 'cau_hinh_van_hanh', true),
  ('dashboard.view', 'Xem Dashboard / Task Center', 'tong_quan', true),
  ('dashboard.manage', 'Quản lý widget Dashboard', 'tong_quan', true),
  ('global_search.use', 'Sử dụng Tìm kiếm toàn hệ thống', 'tong_quan', true),
  ('privacy.view_cccd', 'Xem CCCD (Export / Tìm kiếm)', 'quyen_rieng_tu', true),
  ('privacy.view_phone', 'Xem SĐT (Export / Tìm kiếm)', 'quyen_rieng_tu', true),
  ('privacy.view_address', 'Xem Địa chỉ (Export)', 'quyen_rieng_tu', true)
ON CONFLICT (key) DO NOTHING;

-- Baseline role_permissions (ON CONFLICT DO NOTHING — không đè cấu hình admin đã có).
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('ADMIN', 'registrations.view', true), ('ADMIN', 'registrations.edit', true),
  ('ADMIN', 'registrations.approve', true), ('ADMIN', 'registrations.export', true),
  ('ADMIN', 'questions.manage', true), ('ADMIN', 'dw.view', true), ('ADMIN', 'dw.edit', true),
  ('ADMIN', 'dw.delete', true), ('ADMIN', 'worker_profile.view', true),
  ('ADMIN', 'worker_profile.edit', true), ('ADMIN', 'departments.manage', true),
  ('ADMIN', 'planning.view', true), ('ADMIN', 'planning.request', true),
  ('ADMIN', 'planning.edit', true), ('ADMIN', 'planning.activate', true),
  ('ADMIN', 'workforce_movements.view', true), ('ADMIN', 'workforce_movements.create', true),
  ('ADMIN', 'workforce_movements.manage', true), ('ADMIN', 'history.view', true),
  ('ADMIN', 'history.restore', true), ('ADMIN', 'recycle_bin.manage', true),
  ('ADMIN', 'import.run', true), ('ADMIN', 'field_definitions.manage', true),
  ('ADMIN', 'users.view', true), ('ADMIN', 'users.manage', true),
  ('ADMIN', 'data_scope.view', true), ('ADMIN', 'data_scope.manage', true),
  ('ADMIN', 'rbac.view', true), ('ADMIN', 'rbac.manage', true), ('ADMIN', 'audit.view', true),
  ('ADMIN', 'workflow.manage', true), ('ADMIN', 'rules.manage', true),
  ('ADMIN', 'notifications.manage', true), ('ADMIN', 'branding.manage', true),
  ('ADMIN', 'system.view', true), ('ADMIN', 'backup.manage', true),
  ('ADMIN', 'dashboard.view', true), ('ADMIN', 'dashboard.manage', true),
  ('ADMIN', 'global_search.use', true), ('ADMIN', 'privacy.view_cccd', true),
  ('ADMIN', 'privacy.view_phone', true), ('ADMIN', 'privacy.view_address', true),
  ('HR_RECRUITER', 'registrations.view', true), ('HR_RECRUITER', 'registrations.edit', true),
  ('HR_RECRUITER', 'registrations.approve', true), ('HR_RECRUITER', 'registrations.export', true),
  ('HR_RECRUITER', 'questions.manage', true), ('HR_RECRUITER', 'dw.view', true),
  ('HR_RECRUITER', 'dw.edit', true), ('HR_RECRUITER', 'worker_profile.view', true),
  ('HR_RECRUITER', 'departments.manage', true), ('HR_RECRUITER', 'planning.view', true),
  ('HR_RECRUITER', 'planning.request', true), ('HR_RECRUITER', 'planning.edit', true),
  ('HR_RECRUITER', 'planning.activate', true), ('HR_RECRUITER', 'workforce_movements.view', true),
  ('HR_RECRUITER', 'workforce_movements.create', true),
  ('HR_RECRUITER', 'workforce_movements.manage', true),
  ('HR_RECRUITER', 'history.view', true), ('HR_RECRUITER', 'history.restore', true),
  ('HR_RECRUITER', 'notifications.manage', true), ('HR_RECRUITER', 'dashboard.view', true),
  ('HR_RECRUITER', 'global_search.use', true), ('HR_RECRUITER', 'privacy.view_cccd', true),
  ('HR_RECRUITER', 'privacy.view_phone', true), ('HR_RECRUITER', 'privacy.view_address', true),
  ('DEPT_MANAGER', 'registrations.view', true), ('DEPT_MANAGER', 'planning.view', true),
  ('DEPT_MANAGER', 'planning.request', true), ('DEPT_MANAGER', 'workforce_movements.view', true),
  ('DEPT_MANAGER', 'workforce_movements.create', true), ('DEPT_MANAGER', 'dashboard.view', true),
  ('DEPT_MANAGER', 'global_search.use', true),
  ('HR_DIRECTOR', 'registrations.view', true), ('HR_DIRECTOR', 'registrations.export', true),
  ('HR_DIRECTOR', 'dw.view', true), ('HR_DIRECTOR', 'worker_profile.view', true),
  ('HR_DIRECTOR', 'planning.view', true), ('HR_DIRECTOR', 'workforce_movements.view', true),
  ('HR_DIRECTOR', 'history.view', true), ('HR_DIRECTOR', 'audit.view', true),
  ('HR_DIRECTOR', 'dashboard.view', true), ('HR_DIRECTOR', 'global_search.use', true),
  ('HR_DIRECTOR', 'privacy.view_cccd', true), ('HR_DIRECTOR', 'privacy.view_phone', true),
  ('HR_DIRECTOR', 'privacy.view_address', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- Di trù key cũ -> key mới (tách quyền gộp) — idempotent.
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'dw.view', allowed FROM role_permissions WHERE permission_key = 'workers.view'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'worker_profile.view', allowed FROM role_permissions WHERE permission_key = 'workers.view'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'dw.edit', allowed FROM role_permissions WHERE permission_key = 'workers.edit'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'worker_profile.edit', allowed FROM role_permissions WHERE permission_key = 'workers.edit'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'history.view', allowed FROM role_permissions WHERE permission_key = 'history.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'history.restore', allowed FROM role_permissions WHERE permission_key = 'history.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'rbac.view', allowed FROM role_permissions WHERE permission_key = 'permissions.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'rbac.manage', allowed FROM role_permissions WHERE permission_key = 'permissions.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'data_scope.view', allowed FROM role_permissions WHERE permission_key = 'data_scopes.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'data_scope.manage', allowed FROM role_permissions WHERE permission_key = 'data_scopes.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'planning.edit', allowed FROM role_permissions WHERE permission_key = 'planning.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'planning.activate', allowed FROM role_permissions WHERE permission_key = 'planning.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'planning.request', allowed FROM role_permissions WHERE permission_key = 'planning.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'dashboard.view', allowed FROM role_permissions WHERE permission_key = 'dashboard.manage'
ON CONFLICT (role, permission_key) DO NOTHING;

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
  worker_id uuid NOT NULL REFERENCES worker_profiles(id) ON DELETE RESTRICT,
  daily_application_id uuid,
  dept_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
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
  worker_id uuid NOT NULL REFERENCES worker_profiles(id) ON DELETE RESTRICT,
  from_dept_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
  to_dept_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
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
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  section varchar(120),
  group_name varchar(120),
  location varchar(120),
  division varchar(120),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'DRAFT',
  version integer NOT NULL DEFAULT 1,
  request_type varchar(24) NOT NULL DEFAULT 'ORIGINAL',
  supplement_index integer NOT NULL DEFAULT 0,
  parent_period_id uuid REFERENCES planning_periods(id) ON DELETE SET NULL,
  superseded_by uuid,
  created_by varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS planning_dept_status_idx ON planning_periods (department_id, status);
CREATE INDEX IF NOT EXISTS planning_parent_idx ON planning_periods (parent_period_id);

CREATE TABLE IF NOT EXISTS planning_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_period_id uuid NOT NULL REFERENCES planning_periods(id) ON DELETE CASCADE,
  demand_male integer NOT NULL DEFAULT 0,
  demand_female integer NOT NULL DEFAULT 0,
  target_count integer NOT NULL DEFAULT 0,
  note text
);
CREATE UNIQUE INDEX IF NOT EXISTS planning_target_period_uq ON planning_targets (planning_period_id);

CREATE TABLE IF NOT EXISTS planning_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employment_session_id uuid NOT NULL,
  planning_period_id uuid NOT NULL,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  allocated_by varchar(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS planning_alloc_session_idx ON planning_allocations (employment_session_id);
CREATE INDEX IF NOT EXISTS planning_alloc_period_idx ON planning_allocations (planning_period_id);
CREATE UNIQUE INDEX IF NOT EXISTS planning_alloc_session_period_uq ON planning_allocations (employment_session_id, planning_period_id);

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

-- ============================================================
-- CẬP NHẬT — PRODUCTION HARDENING AUDIT (P0-6, P1-2, Phase 6)
-- An toàn chạy lại nhiều lần (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
-- KHÔNG xoá/sửa dữ liệu hiện có — chỉ thêm cột mới (có DEFAULT, tự backfill an toàn) và thêm
-- unique index. TRƯỚC KHI chạy 2 khối CREATE UNIQUE INDEX bên dưới trên 1 database ĐÃ CÓ dữ
-- liệu thật, hãy chạy 2 câu SELECT kiểm tra tương ứng — nếu trả về 0 dòng thì chạy migration an
-- toàn tuyệt đối; nếu có dòng nào trả về (dữ liệu trùng lặp có sẵn từ trước), phải xử lý dữ liệu
-- đó trước (không tự động xoá gì ở đây) rồi mới chạy CREATE UNIQUE INDEX.
-- ============================================================

-- P0-6 — SESSION REVOCATION: cột mới, có DEFAULT 1, không ảnh hưởng session đang đăng nhập
-- (JWT cũ không có claim sessionVersion → getSession() so `undefined !== 1` → coi như hết hạn,
-- người dùng chỉ cần đăng nhập lại 1 lần sau khi deploy bản này).
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;

-- Kiểm tra TRƯỚC khi chạy unique index bên dưới (planning_targets) — kỳ vọng 0 dòng:
--   SELECT planning_period_id, count(*) FROM planning_targets GROUP BY planning_period_id HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS planning_target_period_uq ON planning_targets (planning_period_id);

-- Kiểm tra TRƯỚC khi chạy unique index bên dưới (workforce_movements) — kỳ vọng 0 dòng:
--   SELECT related_movement_id, count(*) FROM workforce_movements
--   WHERE movement_type = 'resignation' AND related_movement_id IS NOT NULL
--   GROUP BY related_movement_id HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS workforce_movement_spawn_resignation_uq ON workforce_movements (related_movement_id)
  WHERE movement_type = 'resignation' AND related_movement_id IS NOT NULL;

-- ============================================================
-- CẬP NHẬT 2026-08-13 — FORM TARGETING + CCCD ĐÚNG 12 CHỮ SỐ
-- ============================================================
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS visible_to_applicants boolean NOT NULL DEFAULT true;
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS target_audience varchar(20) NOT NULL DEFAULT 'ALL';
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS skip_for_returning boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_questions_target_audience_chk') THEN
    ALTER TABLE form_questions ADD CONSTRAINT form_questions_target_audience_chk
      CHECK (target_audience IN ('ALL', 'NEW_ONLY', 'RETURNING_ONLY'));
  END IF;
END $$;

-- NOT VALID giữ nguyên dữ liệu lịch sử chưa chuẩn hoá nhưng chặn mọi INSERT/UPDATE mới sai định dạng.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_applications_cccd_exact_12_chk') THEN
    ALTER TABLE daily_applications ADD CONSTRAINT daily_applications_cccd_exact_12_chk
      CHECK (cccd IS NOT NULL AND cccd ~ '^[0-9]{12}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dw_data_cccd_exact_12_chk') THEN
    ALTER TABLE dw_data ADD CONSTRAINT dw_data_cccd_exact_12_chk
      CHECK (cccd IS NOT NULL AND cccd ~ '^[0-9]{12}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_profiles_cccd_exact_12_chk') THEN
    ALTER TABLE worker_profiles ADD CONSTRAINT worker_profiles_cccd_exact_12_chk
      CHECK (cccd IS NOT NULL AND cccd ~ '^[0-9]{12}$') NOT VALID;
  END IF;
END $$;

-- ============================================================
-- CẬP NHẬT 2026-08-15 — DOCUMENT MERGE + KÝ NHẬN HỒ SƠ TẬP NGHỀ
-- Dual-template (Tài liệu A / Tài liệu B), đẩy link tới /lookup,
-- chữ ký điện tử + câu trả lời xác nhận.
-- An toàn chạy lại nhiều lần.
-- ============================================================

ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS merged_doc_url text;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS merged_doc_pdf_url text;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS merged_template_id uuid;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS document_sent_at timestamptz;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS signature_data_url text;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS signature_confirmed_at timestamptz;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS confirmed_answers jsonb DEFAULT '{}';

CREATE INDEX IF NOT EXISTS daily_app_document_sent_idx
  ON daily_applications (document_sent_at)
  WHERE document_sent_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS daily_app_signature_idx
  ON daily_applications (signature_confirmed_at)
  WHERE signature_confirmed_at IS NOT NULL;

ALTER TABLE merge_templates ADD COLUMN IF NOT EXISTS document_kind varchar(16) NOT NULL DEFAULT 'GENERIC';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merge_templates_document_kind_chk') THEN
    ALTER TABLE merge_templates ADD CONSTRAINT merge_templates_document_kind_chk
      CHECK (document_kind IN ('A', 'B', 'GENERIC'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS merge_template_kind_idx ON merge_templates (document_kind, is_active);

-- =====================================================================-- WORKFORCE REQUEST LINKAGE (2026-08-16) — Workforce Request ↔ Planning ↔
-- Employment/Allocation (xem migrations/2026-08-16-workforce-request-linkage.sql)
-- Additive + idempotent — KHÔNG DROP / KHÔNG DELETE dữ liệu hiện có.
-- ============================================================================

-- Quyền mới (catalog) — idempotent.
INSERT INTO permissions (key, name, group_name, is_system) VALUES
  ('planning.overallocate', 'Override phân bổ vượt tổng nhu cầu (Planning)', 'planning', true),
  ('workforce_request.view', 'Xem Workforce Request (Yêu cầu nhân lực)', 'planning', true),
  ('workforce_request.allocate', 'Phân bổ / tái phân bổ lao động vào Workforce Request', 'planning', true),
  ('workforce_request.comment', 'Bình luận trên Workforce Request', 'planning', true)
ON CONFLICT (key) DO NOTHING;

-- Baseline: view cho mọi vai trò nghiệp vụ; allocate cho HR_RECRUITER;
-- comment cho HR_RECRUITER / DEPT_MANAGER / HR_DIRECTOR.
-- planning.overallocate MẶC ĐỊNH KHÔNG CẤP CHO AI (fail-closed, trừ ADMIN bypass) —
-- admin cấp thêm tại /admin/permissions khi business cần override.
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('ADMIN', 'workforce_request.view', true), ('ADMIN', 'workforce_request.allocate', true),
  ('ADMIN', 'workforce_request.comment', true), ('ADMIN', 'planning.overallocate', true),
  ('HR_RECRUITER', 'workforce_request.view', true), ('HR_RECRUITER', 'workforce_request.allocate', true),
  ('HR_RECRUITER', 'workforce_request.comment', true),
  ('DEPT_MANAGER', 'workforce_request.view', true), ('DEPT_MANAGER', 'workforce_request.comment', true),
  ('HR_DIRECTOR', 'workforce_request.view', true), ('HR_DIRECTOR', 'workforce_request.comment', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- Liên kết ID (mục 8) — không match bằng text Department/Date.
ALTER TABLE recruitment_requests ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;
-- (index recruitment_requests_department_id_idx do migration 2026-08-17 tạo; không tạo index trùng ở đây)

ALTER TABLE planning_periods ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES recruitment_requests(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS planning_request_idx ON planning_periods (request_id);

ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES recruitment_requests(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS daily_app_request_idx ON daily_applications (request_id);

-- Request allocation (mục 1 + 4).
CREATE TABLE IF NOT EXISTS request_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employment_session_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  request_id uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ACTIVE',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  allocated_by varchar(64) NOT NULL,
  ended_by varchar(64),
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS request_alloc_one_active_per_worker_uq
  ON request_allocations (worker_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS request_alloc_request_status_idx ON request_allocations (request_id, status);
CREATE INDEX IF NOT EXISTS request_alloc_session_idx ON request_allocations (employment_session_id);
CREATE INDEX IF NOT EXISTS request_alloc_worker_idx ON request_allocations (worker_id);

-- Allocation history (mục 15).
CREATE TABLE IF NOT EXISTS request_allocation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  employment_session_id uuid,
  from_request_id uuid,
  to_request_id uuid,
  action varchar(24) NOT NULL,
  reason text,
  override_confirmed boolean NOT NULL DEFAULT false,
  changed_by varchar(64) NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_alloc_history_request_idx ON request_allocation_history (request_id, changed_at);
CREATE INDEX IF NOT EXISTS request_alloc_history_worker_idx ON request_allocation_history (worker_id, changed_at);
CREATE INDEX IF NOT EXISTS request_alloc_history_from_idx ON request_allocation_history (from_request_id);
CREATE INDEX IF NOT EXISTS request_alloc_history_to_idx ON request_allocation_history (to_request_id);

-- Override log RIÊNG (mục 6 + 15).
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
CREATE INDEX IF NOT EXISTS request_override_request_idx ON request_allocation_overrides (request_id, created_at);

-- Comments (mục 11).
CREATE TABLE IF NOT EXISTS request_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  user_id uuid,
  username varchar(64) NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_comment_request_idx ON request_comments (request_id, created_at);

-- KPI cache (mục 9) — có timestamp + recompute job; KHÔNG phải source of truth.
CREATE TABLE IF NOT EXISTS request_kpi_cache (
  request_id uuid PRIMARY KEY,
  as_of_date date NOT NULL,
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_kpi_cache_computed_idx ON request_kpi_cache (computed_at);

-- =====
-- ============================================================
-- CẬP NHẬT 2026-08-16 — EMPLOYMENT LIFECYCLE (Vòng đời làm việc)
-- ------------------------------------------------------------
-- SOURCE OF TRUTH: daily_applications = lịch sử ĐĂNG KÝ;
-- employment_sessions + workforce_movements = lịch sử LÀM VIỆC.
-- ACTIVE := status='APPROVED' AND end_date IS NULL.
-- Bản apply production dùng migrations/2026-08-16-employment-lifecycle.sql
-- (có bước audit dữ liệu bẩn trước khi tạo unique index).
-- An toàn chạy lại nhiều lần.
-- ============================================================

ALTER TABLE employment_sessions ADD COLUMN IF NOT EXISTS end_reason varchar(40);
ALTER TABLE employment_sessions ADD COLUMN IF NOT EXISTS ended_by varchar(64);
ALTER TABLE employment_sessions ADD COLUMN IF NOT EXISTS ended_at timestamptz;
ALTER TABLE employment_sessions ADD COLUMN IF NOT EXISTS end_movement_id uuid;
ALTER TABLE employment_sessions ADD COLUMN IF NOT EXISTS start_date_source varchar(24) DEFAULT 'ASSIGNMENT';

ALTER TABLE workforce_movements ADD COLUMN IF NOT EXISTS employment_session_id uuid;
ALTER TABLE workforce_movements ADD COLUMN IF NOT EXISTS confirmed_by varchar(64);
ALTER TABLE workforce_movements ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE workforce_movements ADD COLUMN IF NOT EXISTS source varchar(32);
CREATE INDEX IF NOT EXISTS workforce_movement_session_idx ON workforce_movements (employment_session_id);

ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS worker_declared_previous_resignation boolean NOT NULL DEFAULT false;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS declared_previous_dept_id uuid;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS declared_previous_session_id uuid;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS declared_resignation_date date;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS declared_resignation_note text;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS declared_at timestamptz;

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
CREATE UNIQUE INDEX IF NOT EXISTS start_date_correction_pending_uq
  ON start_date_corrections (employment_session_id) WHERE status = 'PENDING_ADMIN_APPROVAL';
CREATE INDEX IF NOT EXISTS start_date_correction_status_idx ON start_date_corrections (status);
CREATE INDEX IF NOT EXISTS start_date_correction_worker_idx ON start_date_corrections (worker_id);

CREATE OR REPLACE VIEW v_duplicate_active_employment AS
SELECT worker_id, count(*) AS active_sessions, array_agg(id ORDER BY reg_date DESC) AS session_ids
FROM employment_sessions
WHERE status = 'APPROVED' AND end_date IS NULL
GROUP BY worker_id
HAVING count(*) > 1;

-- INVARIANT: 1 worker = tối đa 1 ACTIVE session. Với DB mới (sạch) tạo trực tiếp;
-- với DB đang chạy dùng migration (có kiểm tra dữ liệu bẩn + NOTICE thay vì fail).
DO $$
DECLARE dirty integer;
BEGIN
  SELECT count(*) INTO dirty FROM v_duplicate_active_employment;
  IF dirty = 0 AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'employment_session_one_active_uq') THEN
    CREATE UNIQUE INDEX employment_session_one_active_uq
      ON employment_sessions (worker_id)
      WHERE status = 'APPROVED' AND end_date IS NULL;
  END IF;
END $$;

-- ============================================================
-- DOCUMENT MERGE — ASYNC HTML/PDF ENGINE (Phase 2)
-- Template versioning + document_history + archive_runs
-- (idempotent, non-destructive — khớp migrations/2026-08-17-document-merge-async-phase2.sql)
-- ============================================================

ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS output_pdf_file_id varchar(255);
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS output_zip_file_id varchar(255);
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS batch_expires_at timestamptz;

ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS filename varchar(255);
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS file_size bigint;
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS sha256 varchar(64);
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS document_history_id uuid;

CREATE TABLE IF NOT EXISTS merge_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid REFERENCES merge_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'DRAFT',
  html_body text,
  print_css text,
  source_docx_name varchar(255),
  retention_years integer,
  mapping_snapshot jsonb DEFAULT '[]',
  created_by varchar(64) NOT NULL,
  published_at timestamptz,
  archived_at timestamptz,
  superseded_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
CREATE INDEX IF NOT EXISTS merge_template_version_status_idx ON merge_template_versions (template_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS merge_template_version_published_uq
  ON merge_template_versions (template_id) WHERE status = 'PUBLISHED';

CREATE TABLE IF NOT EXISTS document_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid,
  application_id uuid,
  merge_job_id uuid,
  merge_job_record_id uuid,
  template_id uuid,
  template_version integer,
  document_type varchar(64),
  generated_at timestamptz NOT NULL DEFAULT now(),
  filename varchar(255) NOT NULL,
  storage_provider varchar(32) NOT NULL DEFAULT 'google_drive',
  storage_file_id varchar(255),
  file_size bigint,
  sha256 varchar(64),
  retention_until timestamptz,
  retention_policy_snapshot jsonb DEFAULT '{}',
  archive_status varchar(24) NOT NULL DEFAULT 'ONLINE',
  archived_at timestamptz,
  archive_verified_at timestamptz,
  archive_path text,
  archive_sha256 varchar(64),
  online_deleted_at timestamptz,
  deletion_reason varchar(64),
  created_by varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_history_archive_idx ON document_history (archive_status, retention_until);
CREATE INDEX IF NOT EXISTS document_history_candidate_idx ON document_history (candidate_id);
CREATE INDEX IF NOT EXISTS document_history_application_idx ON document_history (application_id);
CREATE INDEX IF NOT EXISTS document_history_job_idx ON document_history (merge_job_id);

CREATE TABLE IF NOT EXISTS archive_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type varchar(16) NOT NULL DEFAULT 'MANUAL',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status varchar(24) NOT NULL DEFAULT 'RUNNING',
  manifest_path text,
  downloaded_count integer NOT NULL DEFAULT 0,
  verified_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_summary text
);
CREATE INDEX IF NOT EXISTS archive_runs_started_idx ON archive_runs (started_at);

ALTER TABLE merge_templates ADD COLUMN IF NOT EXISTS retention_years integer;
ALTER TABLE merge_templates ADD COLUMN IF NOT EXISTS html_enabled boolean NOT NULL DEFAULT false;

-- ============================================================
-- DOCUMENT MERGE — TEMPLATE VERSIONING (Phase 3)
-- ============================================================
ALTER TABLE merge_templates ADD COLUMN IF NOT EXISTS current_published_version integer;

-- ============================================================
-- DOCUMENT MERGE — SEED: Dang_ky_Tap_nghe HTML version v1 (DRAFT)
-- (khớp migrations/2026-08-21-dang-ky-tap-nghe-html-draft.sql)
-- ============================================================

ALTER TABLE merge_jobs ALTER COLUMN template_id DROP NOT NULL;
