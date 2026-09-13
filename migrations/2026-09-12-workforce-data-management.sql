-- WORKFORCE DATA MANAGEMENT (Mission D) — import batch tracking for the NEW
-- repeatable Master DW (dw_data) upsert import and IT Code (mã số công nhật)
-- reconciliation import. IT Code is an operational attendance/day-worker
-- assignment code, never the worker identity key (CCCD is) — see the
-- identity & IT Code contract review, 2026-09-13.
--
-- Additive only: two brand-new tables, zero changes to any existing table.
-- Deliberately NOT reusing the existing `import_batches`/`import_staging_rows`
-- tables (Import Engine v2, still live for department/dw_data/daily_application
-- via /admin/import-data) — those have insert-only-dedup semantics for
-- dw_data (ON CONFLICT DO NOTHING) that must not change, and Drizzle emits
-- an explicit column list (never SELECT *), so adding columns to that shared
-- table would break its EXISTING, currently-working queries in Production the
-- instant this code deploys, before this migration ever runs. Two new tables
-- carries zero risk to anything already running.
--
-- source_checksum + the partial unique index below is the idempotency guard
-- (Data Management mission section 35): re-submitting the exact same file
-- while a previous batch of the same import_type is still live (not FAILED/
-- REPLACED) is rejected at the DB level, not just in application code.

CREATE TABLE IF NOT EXISTS workforce_data_import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_type       varchar(40) NOT NULL,               -- WORKFORCE_MASTER | IT_CODE
  dataset_mode      varchar(16) NOT NULL DEFAULT 'TEST', -- TEST | OFFICIAL (administrative label only — never read by Employment/Current Workforce logic)
  environment       varchar(24) NOT NULL,                -- snapshot of the resolved environment at run time (development | preview | production)
  source_filename   varchar(255) NOT NULL,
  source_checksum   varchar(64) NOT NULL,                -- sha256 hex of the uploaded file content
  status            varchar(20) NOT NULL DEFAULT 'STAGED', -- STAGED | VALIDATING | VALIDATED | IMPORTING | COMPLETED | FAILED | REPLACED
  total_rows        integer NOT NULL DEFAULT 0,
  valid_rows        integer NOT NULL DEFAULT 0,
  invalid_rows      integer NOT NULL DEFAULT 0,
  new_rows          integer NOT NULL DEFAULT 0,
  existing_rows     integer NOT NULL DEFAULT 0,
  matched_rows      integer NOT NULL DEFAULT 0,          -- IT Code reconciliation: MATCHED against dw_data
  unmatched_rows    integer NOT NULL DEFAULT 0,
  duplicate_rows    integer NOT NULL DEFAULT 0,           -- duplicate CCCD within the file itself
  processed_rows    integer NOT NULL DEFAULT 0,
  notes             text,
  created_by        varchar(64) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  validated_at      timestamptz,
  completed_at      timestamptz
);

-- Idempotency (section 35): same file (by checksum) for the same import_type
-- cannot be re-submitted while an earlier batch is still STAGED/VALIDATING/
-- VALIDATED/IMPORTING/COMPLETED — only after it is explicitly marked FAILED
-- or REPLACED does the checksum free up.
CREATE UNIQUE INDEX IF NOT EXISTS workforce_data_import_batch_checksum_uq
  ON workforce_data_import_batches (import_type, source_checksum)
  WHERE status NOT IN ('FAILED', 'REPLACED');

CREATE INDEX IF NOT EXISTS workforce_data_import_batch_type_status_idx
  ON workforce_data_import_batches (import_type, status, created_at DESC);

CREATE TABLE IF NOT EXISTS workforce_data_import_rows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    uuid NOT NULL REFERENCES workforce_data_import_batches(id) ON DELETE CASCADE,
  row_number  integer NOT NULL,
  raw_data    jsonb NOT NULL,
  status      varchar(20) NOT NULL DEFAULT 'PENDING', -- PENDING | VALID | INVALID | INSERTED | UPDATED | MATCHED | UNMATCHED | DUPLICATE | ERROR
  message     text
);

CREATE INDEX IF NOT EXISTS workforce_data_import_row_batch_status_idx
  ON workforce_data_import_rows (batch_id, status);
