-- ============================================================
-- DOCUMENT MERGE — ASYNC PDF ENGINE (Phase 1)
-- ------------------------------------------------------------
-- Mở rộng merge_jobs / merge_job_records để hỗ trợ kiến trúc
-- batch bất đồng bộ:
--   Neon (job state) -> async queue -> HTML/CSS render -> Playwright PDF
--   -> object storage -> PDF tổng + ZIP.
--
-- NGUYÊN TẮC AN TOÀN:
--   - KHÔNG destructive: chỉ ADD COLUMN IF NOT EXISTS + CREATE INDEX.
--   - KHÔNG xoá/drop bảng hay cột. Google Docs engine giữ nguyên.
--   - Reuse merge_job_records làm bảng "item" (không tạo bảng trùng).
--   - Idempotent: chạy lại nhiều lần không lỗi.
-- ============================================================

-- ============================================================
-- merge_jobs — thêm cột async queue + output metadata
-- ============================================================
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS engine varchar(16) NOT NULL DEFAULT 'GOOGLE_DOCS';
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS queued_count integer NOT NULL DEFAULT 0;
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS processing_count integer NOT NULL DEFAULT 0;
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS completed_count integer NOT NULL DEFAULT 0;
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0;
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS progress_percent integer NOT NULL DEFAULT 0;
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS output_pdf_url text;
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS output_zip_url text;
ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS error_summary text;

-- Watchdog reclaim: job QUEUED/PROCESSING nhưng updated_at cũ -> coi là treo.
CREATE INDEX IF NOT EXISTS merge_job_status_updated_idx ON merge_jobs (status, updated_at);

-- ============================================================
-- merge_job_records — thêm cột item-level (claim/lease/retry/output)
-- ------------------------------------------------------------
-- sort_order  = sequence (thứ tự in, source of truth).
-- status      = QUEUED | PROCESSING | COMPLETED | FAILED | RETRY | PAUSED | CANCELLED
--               (legacy PENDING/RUNNING được normalize tương đương QUEUED/PROCESSING)
-- ============================================================
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS leased_until timestamptz;
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS retry_at timestamptz;
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS pdf_url text;
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS error_code varchar(64);
ALTER TABLE merge_job_records ADD COLUMN IF NOT EXISTS error_message text;

-- Claim items theo job + sequence (đúng thứ tự user chọn) cho FOR UPDATE SKIP LOCKED.
CREATE INDEX IF NOT EXISTS merge_job_record_claim_idx
  ON merge_job_records (merge_job_id, status, sort_order)
  WHERE status IN ('QUEUED', 'RETRY');

-- ============================================================
-- Xong. Không thay đổi dữ liệu hiện có.
-- ============================================================
