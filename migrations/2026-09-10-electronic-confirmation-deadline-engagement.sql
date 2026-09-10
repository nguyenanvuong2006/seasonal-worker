-- ELECTRONIC CONFIRMATION — CONFIRMATION DEADLINE + ENGAGEMENT LINKAGE
--
-- Additive only: two new nullable columns on candidate_documents + their
-- indexes, plus a deterministic backfill of ONLY the engagement-linkage
-- column (never the deadline column — see below). No DROP/TRUNCATE/DELETE,
-- no existing column altered, no employment_sessions/daily_applications/
-- document_confirmations row touched.
--
-- employment_session_id: the canonical "one beginning of work" entity for
-- each Electronic Confirmation document. Backfilled deterministically —
-- employment_sessions.daily_application_id is UNIQUE when non-null
-- (employment_session_daily_app_uq), so "the one employment_sessions row
-- whose daily_application_id equals this document's application_id" is
-- either exactly one row or none; never ambiguous, never guessed. A
-- document with no match (e.g. the session was created via import/
-- reconciliation with no daily_application_id) is left NULL — explicitly
-- "legacy/unlinked", per this mission's instruction to never guess
-- ambiguous historical linkage.
--
-- confirmation_deadline_at: deliberately NOT backfilled for any existing
-- row, including currently-ISSUED/VIEWED documents awaiting confirmation.
-- Retroactively imposing a deadline on a document a real candidate may
-- already be mid-flow with is a silent behavior change with real business
-- risk (a document issued 4 days ago would become instantly "expired" the
-- moment this migration runs, blocking a candidate about to confirm) —
-- this needs an explicit, separate decision from the system owner, not an
-- assumption baked into a schema migration. Every document ISSUED after
-- this migration ships gets a real deadline going forward.

ALTER TABLE candidate_documents
  ADD COLUMN IF NOT EXISTS employment_session_id uuid NULL,
  ADD COLUMN IF NOT EXISTS confirmation_deadline_at timestamptz NULL;

UPDATE candidate_documents cd
SET employment_session_id = es.id
FROM employment_sessions es
WHERE es.daily_application_id = cd.application_id
  AND cd.employment_session_id IS NULL;

CREATE INDEX IF NOT EXISTS candidate_document_employment_session_idx
  ON candidate_documents (employment_session_id);

CREATE INDEX IF NOT EXISTS candidate_document_status_deadline_idx
  ON candidate_documents (status, confirmation_deadline_at)
  WHERE status IN ('ISSUED', 'VIEWED');
