-- ============================================================
-- AI COPILOT — ACTION PROPOSALS (Phase 3 "Safe Action Copilot")
-- ------------------------------------------------------------
-- NEW, additive-only table. The AI Copilot may PREPARE a write (e.g. "Tạo
-- yêu cầu tuyển 30 người cho Harvesting") but must NEVER execute it on its
-- own — this table is the tamper-proof, server-persisted proposal that
-- makes that possible: the execute endpoint receives ONLY a proposal id
-- from the browser, never a payload, so the browser cannot change
-- "30 workers" into "300 workers" between preview and confirmation.
--
-- SAFETY:
--   - Forward-only: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
--     EXISTS. No ALTER on any existing table, no DROP, no data migration.
--   - Idempotent: safe to run more than once.
--   - No FK to recruitment_requests/departments — kept soft/logical
--     (matches this repo's existing merge_jobs/candidate_documents
--     convention for cross-table references), since a proposal may target
--     an action whose domain table this migration has no reason to couple to.
--
-- NOT YET APPLIED to any database as of this revision. Per this repo's
-- migration governance (docs/PRODUCTION-DEPLOY.md): every non-Document-
-- Merge migration is applied MANUALLY, never by CI. This file must be
-- reviewed and run against Production ONLY after a human has personally
-- confirmed a current Production backup/snapshot exists — never self-
-- confirmed by an automated agent.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  payload jsonb NOT NULL,
  human_readable_preview text NOT NULL,
  department_id uuid,
  required_permission varchar(120) NOT NULL,
  data_scope_snapshot jsonb,
  idempotency_key varchar(128) NOT NULL,
  created_by varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmed_by varchar(64),
  confirmed_at timestamptz,
  executed_at timestamptz,
  execution_result jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_action_proposal_status_chk CHECK (
    status IN ('PENDING', 'CONFIRMED', 'EXECUTED', 'FAILED', 'EXPIRED', 'CANCELLED')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_action_proposal_idempotency_uq ON ai_action_proposals (idempotency_key);
CREATE INDEX IF NOT EXISTS ai_action_proposal_created_by_idx ON ai_action_proposals (created_by);
CREATE INDEX IF NOT EXISTS ai_action_proposal_status_idx ON ai_action_proposals (status);

-- ============================================================
-- Xong. Không đổi dữ liệu hiện có, không ALTER bảng hiện có.
-- ============================================================
