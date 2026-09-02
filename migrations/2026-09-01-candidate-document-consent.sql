-- ============================================================
-- CANDIDATE DOCUMENT ISSUANCE + ZERO-COST ELECTRONIC CONSENT
-- ------------------------------------------------------------
-- Individual PDF issuance per candidate + tamper-evident electronic
-- consent evidence ("Xác nhận đồng ý" — NOT PKI, not a digital
-- certificate). Reuses existing tables (daily_applications,
-- merge_jobs/merge_job_records, merge_templates) for identity,
-- generation, and templating — these are NEW, minimal, additive
-- tables only for what does not already exist.
--
-- SAFETY:
--   - Forward-only: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
--     EXISTS. No ALTER on existing tables, no DROP, no data migration.
--   - Idempotent: safe to run more than once.
--   - No FK constraints added (matches this repo's existing
--     merge_jobs/merge_job_records/document_history convention of
--     soft/logical references — avoids migration-order coupling).
--   - CHECK constraints validate enum-shaped columns at the DB layer
--     (defense in depth alongside the application-level lifecycle
--     guards in lib/candidate-consent/lifecycle.ts) — NOT NULL data
--     yet at first apply, so adding these is non-destructive.
--
-- NOT YET APPLIED to any database as of this revision (see PR #127) —
-- this file was edited in place (not superseded by a second migration)
-- because it has never been run against Production or any other
-- database; editing an unapplied, unreleased migration is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS candidate_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL,
  merge_job_id uuid,
  merge_job_record_id uuid,
  template_id uuid,
  template_version integer,
  document_kind varchar(32) NOT NULL DEFAULT 'GENERIC',
  filename varchar(255),
  storage_provider varchar(32),
  storage_key text,
  file_size bigint,
  pdf_sha256 varchar(64),
  status varchar(16) NOT NULL DEFAULT 'GENERATING',
  generated_at timestamptz,
  issued_at timestamptz,
  issued_by varchar(64),
  viewed_at timestamptz,
  supersedes_document_id uuid,
  revoked_at timestamptz,
  revoked_by varchar(64),
  revoke_reason text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidate_documents_status_chk CHECK (
    status IN ('GENERATING', 'READY', 'ISSUED', 'VIEWED', 'CONFIRMED', 'REVOKED', 'SUPERSEDED', 'EXPIRED', 'FAILED')
  )
);

CREATE INDEX IF NOT EXISTS candidate_document_application_idx ON candidate_documents (application_id);
CREATE INDEX IF NOT EXISTS candidate_document_status_idx ON candidate_documents (status);
CREATE INDEX IF NOT EXISTS candidate_document_merge_job_record_idx ON candidate_documents (merge_job_record_id);
-- Supersedes-chain integrity: lets "find what replaced this document" and
-- "walk the correction lineage" both use an index instead of a full scan.
CREATE INDEX IF NOT EXISTS candidate_document_supersedes_idx ON candidate_documents (supersedes_document_id);
-- Composite (application, status): the exact shape the public documents
-- list route filters/joins by ("this candidate's currently-visible docs").
CREATE INDEX IF NOT EXISTS candidate_document_application_status_idx ON candidate_documents (application_id, status);

CREATE TABLE IF NOT EXISTS candidate_access_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash varchar(64) NOT NULL,
  cccd_hmac varchar(64) NOT NULL,
  scoped_application_ids jsonb NOT NULL DEFAULT '[]',
  identity_verification_method varchar(32) NOT NULL DEFAULT 'CCCD_PHONE',
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  ip_address varchar(64),
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_access_session_token_uq ON candidate_access_sessions (token_hash);
CREATE INDEX IF NOT EXISTS candidate_access_session_cccd_idx ON candidate_access_sessions (cccd_hmac);
-- Session-expiry scan: the finalize/session-resolution path filters live
-- sessions by "not revoked AND not yet expired" — composite index for that.
CREATE INDEX IF NOT EXISTS candidate_access_session_expires_idx ON candidate_access_sessions (expires_at);
CREATE INDEX IF NOT EXISTS candidate_access_session_active_idx ON candidate_access_sessions (revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS document_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_document_id uuid NOT NULL,
  application_id uuid NOT NULL,
  access_session_id uuid NOT NULL,
  pdf_sha256 varchar(64) NOT NULL,
  consent_version varchar(16) NOT NULL,
  consent_text text NOT NULL,
  consent_text_hash varchar(64) NOT NULL,
  identity_verification_method varchar(32) NOT NULL,
  identity_verified_at timestamptz NOT NULL,
  confirmed_at_server timestamptz NOT NULL,
  ip_address varchar(64),
  user_agent text,
  receipt_id varchar(32) NOT NULL,
  evidence_schema_version varchar(8) NOT NULL DEFAULT '1',
  canonical_evidence_hash varchar(64) NOT NULL,
  -- NOT NULL: DOCUMENT_EVIDENCE_SECRET is required to reach this insert at
  -- all in Production (resolveDocumentEvidenceSecret() fails closed before
  -- any confirmation is built) — evidence never silently degrades to a
  -- SHA-256-only record.
  evidence_hmac varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- At most ONE successful confirmation per document — also the concurrency
-- guard: two simultaneous confirm requests for the SAME document can insert
-- at most one row (the second hits this unique violation and is treated as
-- an idempotent "already confirmed", not an error to the candidate).
CREATE UNIQUE INDEX IF NOT EXISTS document_confirmation_document_uq ON document_confirmations (candidate_document_id);
CREATE UNIQUE INDEX IF NOT EXISTS document_confirmation_receipt_uq ON document_confirmations (receipt_id);
CREATE INDEX IF NOT EXISTS document_confirmation_application_idx ON document_confirmations (application_id);

CREATE TABLE IF NOT EXISTS identity_lookup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  limiter_key varchar(64) NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1,
  window_start_at timestamptz NOT NULL,
  locked_until timestamptz,
  lockout_strikes integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS identity_lookup_attempt_key_uq ON identity_lookup_attempts (limiter_key);

-- ============================================================
-- Xong. Không đổi dữ liệu hiện có, không ALTER bảng hiện có.
-- ============================================================
