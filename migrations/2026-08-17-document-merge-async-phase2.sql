-- ============================================================
-- DOCUMENT MERGE — ASYNC HTML/PDF ENGINE (Phase 2)
-- ------------------------------------------------------------
-- Mở rộng schema cho:
--   - template versioning (DRAFT/PUBLISHED/ARCHIVED + retention config)
--   - document_history (mỗi PDF 1 record, retention, archive lifecycle)
--   - merge_jobs/merge_job_records: output file id, batch TTL, per-item
--     filename/file_size/sha256, link tới document_history
--
-- NGUYÊN TẮC AN TOÀN:
--   - KHÔNG destructive: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
--   - KHÔNG xoá/drop bảng, cột, dữ liệu. Google Docs engine giữ nguyên.
--   - Idempotent: chạy lại nhiều lần không lỗi.
-- ============================================================

-- ============================================================
-- merge_jobs — thêm output file id + batch TTL
-- ============================================================
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS output_pdf_file_id varchar(255);
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS output_zip_file_id varchar(255);
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS batch_expires_at timestamptz;
-- watchdog reclaim job treo
CREATE INDEX IF NOT EXISTS merge_job_status_updated_idx ON merge_jobs (status, updated_at);

-- ============================================================
-- merge_job_records — per-item output metadata + sha256
-- ============================================================
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS filename varchar(255);
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS file_size bigint;
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS sha256 varchar(64);
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS document_history_id uuid;

-- ============================================================
-- merge_template_versions — Template versioning (mục E)
-- ============================================================
CREATE TABLE IF NOT EXISTS merge_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES merge_templates(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS merge_template_version_status_idx
  ON merge_template_versions (template_id, status);
-- Chỉ 1 version PUBLISHED/template
CREATE UNIQUE INDEX IF NOT EXISTS merge_template_version_published_uq
  ON merge_template_versions (template_id) WHERE status = 'PUBLISHED';

-- ============================================================
-- document_history — Mỗi PDF = 1 record riêng (mục P)
-- ============================================================
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

-- ============================================================
-- archive_runs — tiến trình Archive Agent (mục S)
-- ============================================================
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

-- ============================================================
-- merge_templates — retention + html_enabled (template builder)
-- ============================================================
ALTER TABLE merge_templates ADD COLUMN IF NOT EXISTS retention_years integer;
ALTER TABLE merge_templates ADD COLUMN IF NOT EXISTS html_enabled boolean NOT NULL DEFAULT false;

-- ============================================================
-- Xong. Không thay đổi dữ liệu hiện có.
-- ============================================================
