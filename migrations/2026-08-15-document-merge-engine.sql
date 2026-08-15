-- ============================================================
-- DOCUMENT MERGE ENGINE — Generic Document Merge Center
-- ============================================================
-- Mục tiêu: Admin có thể tự tạo Google Docs template, quản lý placeholders,
-- map placeholders với dữ liệu hiện có, và merge một hoặc nhiều hồ sơ
-- thành Google Docs mà KHÔNG cần sửa code mỗi khi có mẫu tài liệu mới.
-- An toàn chạy lại nhiều lần (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
-- ============================================================

-- ============================================================
-- merge_templates — Lưu cấu hình Google Docs template
-- ============================================================
CREATE TABLE IF NOT EXISTS merge_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  description text,
  google_doc_id varchar(120) NOT NULL,
  output_folder_id varchar(120),
  output_file_name_pattern varchar(255),
  default_merge_mode varchar(24) NOT NULL DEFAULT 'ONE_DOCUMENT',
  data_sources jsonb DEFAULT '[]',
  is_active boolean NOT NULL DEFAULT true,
  created_by varchar(64) NOT NULL,
  updated_by varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merge_template_active_idx ON merge_templates (is_active);
CREATE INDEX IF NOT EXISTS merge_template_google_doc_idx ON merge_templates (google_doc_id);

-- ============================================================
-- merge_template_fields — Placeholder mappings cho mỗi template
-- ============================================================
CREATE TABLE IF NOT EXISTS merge_template_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES merge_templates(id) ON DELETE CASCADE,
  placeholder varchar(255) NOT NULL,
  source_type varchar(32) NOT NULL DEFAULT 'CORE_FIELD',
  source_entity varchar(64),
  source_field varchar(128),
  source_path varchar(255),
  option_value varchar(255),
  format_type varchar(32),
  fallback_value text,
  is_required boolean NOT NULL DEFAULT false,
  is_orphaned boolean NOT NULL DEFAULT false,
  is_suggested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(template_id, placeholder)
);
CREATE INDEX IF NOT EXISTS merge_template_field_template_idx ON merge_template_fields (template_id);
CREATE INDEX IF NOT EXISTS merge_template_field_placeholder_idx ON merge_template_fields (template_id, placeholder);

-- ============================================================
-- merge_jobs — Lịch sử merge operations
-- ============================================================
CREATE TABLE IF NOT EXISTS merge_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES merge_templates(id) ON DELETE SET NULL,
  template_name_snapshot varchar(255) NOT NULL DEFAULT '',
  merge_mode varchar(24) NOT NULL DEFAULT 'ONE_DOCUMENT',
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  record_count integer NOT NULL DEFAULT 0,
  output_doc_id varchar(120),
  output_url text,
  created_by varchar(64) NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merge_job_status_idx ON merge_jobs (status);
CREATE INDEX IF NOT EXISTS merge_job_created_by_idx ON merge_jobs (created_by);
CREATE INDEX IF NOT EXISTS merge_job_template_idx ON merge_jobs (template_id);
CREATE INDEX IF NOT EXISTS merge_job_created_at_idx ON merge_jobs (created_at DESC);

-- ============================================================
-- merge_job_records — Chi tiết từng record trong một merge job
-- ============================================================
CREATE TABLE IF NOT EXISTS merge_job_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merge_job_id uuid NOT NULL REFERENCES merge_jobs(id) ON DELETE CASCADE,
  source_entity varchar(64) NOT NULL,
  source_record_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merge_job_record_job_idx ON merge_job_records (merge_job_id);
CREATE INDEX IF NOT EXISTS merge_job_record_source_idx ON merge_job_records (source_entity, source_record_id);

-- ============================================================
-- DOCUMENT MERGE PERMISSIONS
-- ============================================================
INSERT INTO permissions (key, name, group_name, is_system) VALUES
  ('document_merge.view', 'Xem Document Merge Center', 'document_merge', true),
  ('document_merge.templates.manage', 'Quản lý Templates', 'document_merge', true),
  ('document_merge.execute', 'Thực hiện Merge', 'document_merge', true),
  ('document_merge.history.view', 'Xem Lịch sử Merge', 'document_merge', true),
  ('document_merge.history.delete', 'Xoá Lịch sử Merge', 'document_merge', true)
ON CONFLICT (key) DO NOTHING;

-- Baseline role_permissions
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('ADMIN', 'document_merge.view', true),
  ('ADMIN', 'document_merge.templates.manage', true),
  ('ADMIN', 'document_merge.execute', true),
  ('ADMIN', 'document_merge.history.view', true),
  ('ADMIN', 'document_merge.history.delete', true),
  -- HR_RECRUITER: view + execute + history.view (không manage templates)
  ('HR_RECRUITER', 'document_merge.view', true),
  ('HR_RECRUITER', 'document_merge.templates.manage', true),
  ('HR_RECRUITER', 'document_merge.execute', true),
  ('HR_RECRUITER', 'document_merge.history.view', true),
  ('HR_RECRUITER', 'document_merge.history.delete', true),
  -- HR_DIRECTOR: view + history.view (không execute hoặc manage)
  ('HR_DIRECTOR', 'document_merge.view', true),
  ('HR_DIRECTOR', 'document_merge.history.view', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================
-- SEED TEMPLATE: Đăng ký tập nghề - Quy định tập nghề
-- ============================================================
INSERT INTO merge_templates (id, name, description, google_doc_id, default_merge_mode, data_sources, is_active, created_by, updated_by)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'Đăng ký tập nghề - Quy định tập nghề',
  'Mẫu đăng ký tập nghề và quy định tập nghề cho nhân viên mới',
  '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE',
  'ONE_DOCUMENT',
  '["worker_profiles", "employment_sessions", "departments"]',
  true,
  'SYSTEM',
  'SYSTEM'
) ON CONFLICT DO NOTHING;

-- ============================================================
-- FIELD CATALOG: Available fields cho auto-mapping
-- ============================================================
-- Bảng này lưu trữ metadata về các field có thể được sử dụng trong merge
-- Không cần tạo bảng mới - tận dụng field_definitions và form_questions hiện có
-- Thêm cột mergeable để đánh dấu field có thể dùng trong merge
ALTER TABLE field_definitions ADD COLUMN IF NOT EXISTS mergeable boolean NOT NULL DEFAULT true;
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS mergeable boolean NOT NULL DEFAULT true;

-- ============================================================
-- Xong. Document Merge Engine đã sẵn sàng.
-- ============================================================
