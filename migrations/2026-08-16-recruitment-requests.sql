-- ============================================================
-- MIGRATION — 2026-08-16 — Recruitment Requests (Workforce Recruitment Request Planning)
-- ============================================================
-- Nâng cấp module Planning (Nhu cầu) thành Workforce Recruitment Request Planning,
-- tích hợp với planning_periods, planning_targets, planning_allocations,
-- Daily Application, Employment Session và Workforce Movement.
--
-- Bảng recruitment_requests lưu các yêu cầu tuyển dụng chi tiết, liên kết với
-- planning_periods; không phá hoặc thay thế các bảng Planning hiện có.
--
-- An toàn:
--   * Idempotent — chạy lại nhiều lần không lỗi (CREATE TABLE IF NOT EXISTS /
--     ADD COLUMN IF NOT EXISTS / INSERT ... ON CONFLICT DO NOTHING).
--   * KHÔNG DROP/đổi kiểu bất kỳ bảng/cột nào hiện có.
--   * KHÔNG DELETE/UPDATE dữ liệu nghiệp vụ hiện có.
-- ============================================================

-- ----------------------------------------------------------------
-- 1) Bảng recruitment_requests — Yêu cầu tuyển dụng chi tiết
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_requests (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  planning_period_id uuid REFERENCES planning_periods(id) ON DELETE SET NULL,
  request_code varchar(80) NOT NULL,
  requester varchar(160) NOT NULL DEFAULT '',
  position varchar(160) DEFAULT '',
  job_title varchar(255) DEFAULT '',
  location varchar(120) DEFAULT '',
  section varchar(120) DEFAULT '',
  group_name varchar(120) DEFAULT '',
  division varchar(120) DEFAULT '',
  department varchar(255) DEFAULT '',
  reason text DEFAULT '',
  note_for_reason text DEFAULT '',
  special_requirements text DEFAULT '',
  male_rq integer NOT NULL DEFAULT 0,
  female_rq integer NOT NULL DEFAULT 0,
  male_application integer NOT NULL DEFAULT 0,
  female_application integer NOT NULL DEFAULT 0,
  male_interviewed integer NOT NULL DEFAULT 0,
  female_interviewed integer NOT NULL DEFAULT 0,
  male_recruited integer NOT NULL DEFAULT 0,
  female_recruited integer NOT NULL DEFAULT 0,
  male_quit integer NOT NULL DEFAULT 0,
  female_quit integer NOT NULL DEFAULT 0,
  male_balance integer NOT NULL DEFAULT 0,
  female_balance integer NOT NULL DEFAULT 0,
  total_balance integer NOT NULL DEFAULT 0,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  requested_date date,
  expected_date date,
  offered_date date,
  completed_date date,
  month varchar(10) DEFAULT '',
  cost numeric(12,2) DEFAULT 0,
  remarks text DEFAULT '',
  "to" varchar(160) DEFAULT '',
  rq_status varchar(40) DEFAULT '',
  month_rc varchar(10) DEFAULT '',
  total_request integer NOT NULL DEFAULT 0,
  recruited_vs_expected numeric(5,2) DEFAULT 0,
  screened integer NOT NULL DEFAULT 0,
  interview integer NOT NULL DEFAULT 0,
  recruit integer NOT NULL DEFAULT 0,
  department_text varchar(255) DEFAULT '',
  month_report varchar(10) DEFAULT '',
  created_by varchar(64) NOT NULL,
  deleted_at timestamptz,
  deleted_by varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique index on request_code (allows soft-delete)
CREATE UNIQUE INDEX IF NOT EXISTS recruitment_requests_code_uq
  ON recruitment_requests (request_code)
  WHERE deleted_at IS NULL;

-- Indexes for filtering
CREATE INDEX IF NOT EXISTS recruitment_requests_period_idx
  ON recruitment_requests (planning_period_id);
CREATE INDEX IF NOT EXISTS recruitment_requests_status_idx
  ON recruitment_requests (status);
CREATE INDEX IF NOT EXISTS recruitment_requests_month_idx
  ON recruitment_requests (month);
CREATE INDEX IF NOT EXISTS recruitment_requests_location_idx
  ON recruitment_requests (location);
CREATE INDEX IF NOT EXISTS recruitment_requests_division_idx
  ON recruitment_requests (division);
CREATE INDEX IF NOT EXISTS recruitment_requests_dept_idx
  ON recruitment_requests (department);
CREATE INDEX IF NOT EXISTS recruitment_requests_section_idx
  ON recruitment_requests (section);
CREATE INDEX IF NOT EXISTS recruitment_requests_group_idx
  ON recruitment_requests (group_name);
CREATE INDEX IF NOT EXISTS recruitment_requests_requester_idx
  ON recruitment_requests (requester);
CREATE INDEX IF NOT EXISTS recruitment_requests_created_at_idx
  ON recruitment_requests (created_at);

-- ----------------------------------------------------------------
-- 2) Thêm cột cho planning_periods nếu chưa có (hỗ trợ matching)
-- ----------------------------------------------------------------
ALTER TABLE planning_periods
  ADD COLUMN IF NOT EXISTS request_code varchar(80);

-- ----------------------------------------------------------------
-- 3) field_definitions — định nghĩa trường cho Recruitment Request
-- ----------------------------------------------------------------
INSERT INTO field_definitions (
  field_key, group_name, display_name, database_field,
  import_column_name, export_column_name, aliases,
  field_type, required, searchable, sortable, filterable, exportable, importable,
  sort_order, is_system
) VALUES
  ('rr_request_code', 'recruitment_request', 'Request Code', 'request_code',
   'Request Code', 'Request Code', '["Mã yêu cầu", "Request Code", "Mã tuyển dụng"]',
   'TEXT', true, true, true, true, true, true, 1, true),
  ('rr_requester', 'recruitment_request', 'Requester', 'requester',
   'Requester', 'Requester', '["Người yêu cầu", "Người đề xuất", "Requester"]',
   'TEXT', false, true, true, true, true, true, 2, true),
  ('rr_position', 'recruitment_request', 'Position', 'position',
   'Position', 'Position', '["Vị trí", "Chức vụ", "Position"]',
   'TEXT', false, false, false, true, true, true, 3, true),
  ('rr_job_title', 'recruitment_request', 'Job Title', 'job_title',
   'Job title', 'Job title', '["Chức danh", "Job Title", "Công việc"]',
   'TEXT', false, false, false, true, true, true, 4, true),
  ('rr_location', 'recruitment_request', 'Location', 'location',
   'Location', 'Location', '["Địa điểm", "Location", "Nơi làm việc"]',
   'TEXT', false, true, true, true, true, true, 5, true),
  ('rr_division', 'recruitment_request', 'Division', 'division',
   'Division', 'Division', '["Khối", "Division", "Bộ phận khối"]',
   'TEXT', false, true, true, true, true, true, 6, true),
  ('rr_department', 'recruitment_request', 'Department', 'department',
   'Department', 'Department', '["Phòng ban", "Department", "Bộ phận"]',
   'TEXT', false, true, true, true, true, true, 7, true),
  ('rr_section', 'recruitment_request', 'Section', 'section',
   'Section', 'Section', '["Tổ", "Section", "Bộ phận nhỏ"]',
   'TEXT', false, true, true, true, true, true, 8, true),
  ('rr_group', 'recruitment_request', 'Group', 'group_name',
   'Group', 'Group', '["Nhóm", "Group", "Tổ nhóm"]',
   'TEXT', false, true, true, true, true, true, 9, true),
  ('rr_reason', 'recruitment_request', 'Reason', 'reason',
   'Reason', 'Reason', '["Lý do", "Reason", "Nguyên nhân"]',
   'TEXT', false, false, false, false, true, true, 10, true),
  ('rr_note_for_reason', 'recruitment_request', 'Note for Reason', 'note_for_reason',
   'Note for reason', 'Note for reason', '["Ghi chú lý do", "Note for reason", "Ghi chú"]',
   'TEXT', false, false, false, false, true, true, 11, true),
  ('rr_special_requirements', 'recruitment_request', 'Special Requirements', 'special_requirements',
   'Special Requirements', 'Special Requirements', '["Yêu cầu đặc biệt", "Special Requirements", "Yêu cầu"]',
   'TEXT', false, false, false, false, true, true, 12, true),
  ('rr_male_rq', 'recruitment_request', 'Male Rq', 'male_rq',
   'Male Rq', 'Male Rq', '["Nam Rq", "Nam cần", "Male Required"]',
   'NUMBER', false, false, false, true, true, true, 13, true),
  ('rr_female_rq', 'recruitment_request', 'Female Rq', 'female_rq',
   'Female Rq', 'Female Rq', '["Nữ Rq", "Nữ cần", "Female Required"]',
   'NUMBER', false, false, false, true, true, true, 14, true),
  ('rr_status', 'recruitment_request', 'Status', 'status',
   'Status', 'Status', '["Trạng thái", "Status", "Tình trạng"]',
   'TEXT', false, false, true, true, true, false, 30, true),
  ('rr_requested_date', 'recruitment_request', 'Requested Date', 'requested_date',
   'Requested Date', 'Requested Date', '["Ngày yêu cầu", "Requested Date", "Ngày đề xuất"]',
   'DATE', false, false, true, true, true, true, 20, true),
  ('rr_expected_date', 'recruitment_request', 'Expected Date', 'expected_date',
   'Expected Date', 'Expected Date', '["Ngày dự kiến", "Expected Date", "Ngày mong đợi"]',
   'DATE', false, false, true, true, true, true, 21, true),
  ('rr_offered_date', 'recruitment_request', 'Offered Date', 'offered_date',
   'Offered Date', 'Offered Date', '["Ngày đề nghị", "Offered Date", "Ngày offer"]',
   'DATE', false, false, true, true, true, true, 22, true),
  ('rr_completed_date', 'recruitment_request', 'Completed Date', 'completed_date',
   'Completed Date', 'Completed Date', '["Ngày hoàn thành", "Completed Date"]',
   'DATE', false, false, true, true, true, true, 23, true),
  ('rr_month', 'recruitment_request', 'Month', 'month',
   'Month', 'Month', '["Tháng", "Month", "Kỳ"]',
   'TEXT', false, false, true, true, true, true, 24, true),
  ('rr_cost', 'recruitment_request', 'Cost', 'cost',
   'Cost', 'Cost', '["Chi phí", "Cost", "Phí"]',
   'NUMBER', false, false, false, false, true, true, 25, true),
  ('rr_remarks', 'recruitment_request', 'Remarks', 'remarks',
   'Remarks', 'Remarks', '["Ghi chú thêm", "Remarks", "Nhận xét"]',
   'TEXT', false, false, false, false, true, true, 26, true),
  ('rr_rq_status', 'recruitment_request', 'Rq Status', 'rq_status',
   'Rq Status', 'Rq Status', '["Tình trạng yêu cầu", "Rq Status"]',
   'TEXT', false, false, true, true, true, true, 27, true),
  ('rr_to', 'recruitment_request', 'To', 'to',
   'To', 'To', '["Đến", "To", "Người nhận"]',
   'TEXT', false, false, false, false, true, true, 28, true),
  ('rr_month_rc', 'recruitment_request', 'Month_Rc', 'month_rc',
   'Month_Rc', 'Month_Rc', '["Tháng tuyển", "Month_Rc", "Tháng RC"]',
   'TEXT', false, false, true, true, true, true, 29, true),
  ('rr_department_text', 'recruitment_request', 'Department', 'department_text',
   'Department', 'Department', '["Phòng ban", "Department text"]',
   'TEXT', false, false, true, true, true, true, 31, true),
  ('rr_month_report', 'recruitment_request', 'Month_Report', 'month_report',
   'Month_Report', 'Month_Report', '["Tháng báo cáo", "Month_Report"]',
   'TEXT', false, false, true, true, true, true, 32, true)
ON CONFLICT (field_key) DO NOTHING;

-- ----------------------------------------------------------------
-- 4) Thêm cột hỗ trợ cho staging_nhan_su (nếu cần import bulk sau này)
-- ----------------------------------------------------------------
-- Các cột này có thể thêm sau khi có Import Engine v3 cho recruitment_requests