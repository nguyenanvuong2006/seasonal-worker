-- EFFECTIVE-DATE LIFECYCLE for workforce_movements (resignation + transfer).
--
-- Additive only: one new nullable column on an existing table, a backfill of
-- THAT SAME new column (never touches any other column or table), and one
-- idempotent seed row in scheduled_jobs. No DROP/TRUNCATE/DELETE, no existing
-- column altered, no employment_sessions/worker_profiles/daily_applications
-- row touched.
--
-- lifecycle_applied_at = when the ACTUAL workforce state change (employment
-- session ended / department moved, allocation cleanup, KPI recompute) was
-- applied — distinct from confirmed_at (when HR approved the REQUEST). NULL
-- means "approved but not yet in effect" (worker/department still reflects
-- the pre-movement state until its effective_date arrives).
--
-- BACKFILL RATIONALE: every row in this table that already reached a
-- terminal "approved" status (resignation: INACTIVE, transfer:
-- TRANSFER_COMPLETED) under the PREVIOUS code was applied IMMEDIATELY at
-- approval time, regardless of its effective_date (the bug this migration's
-- accompanying code fix corrects). So for pre-existing rows, "applied" is
-- already true — the backfill marks them as such using the best available
-- timestamp (confirmed_at, else updated_at, else created_at) so the new
-- applyEffectiveWorkforceMovements() scheduler never re-applies (double-runs)
-- history that already took effect under the old code path.

ALTER TABLE workforce_movements
  ADD COLUMN IF NOT EXISTS lifecycle_applied_at timestamptz NULL;

UPDATE workforce_movements
SET lifecycle_applied_at = COALESCE(confirmed_at, updated_at, created_at)
WHERE movement_type IN ('resignation', 'transfer')
  AND status IN ('INACTIVE', 'TRANSFER_COMPLETED')
  AND lifecycle_applied_at IS NULL;

CREATE INDEX IF NOT EXISTS workforce_movement_pending_effect_idx
  ON workforce_movements (effective_date)
  WHERE lifecycle_applied_at IS NULL;

-- Seed the new scheduled job (idempotent — same pattern as every other
-- scheduler.ts entry seeded via lib/seed.ts's DEFAULT_SCHEDULED_JOBS, needed
-- here too because this is an existing Production database, not a fresh
-- seed). Disabled by default is NOT an option here — a movement approved
-- with a future effective date must actually take effect once that date
-- arrives even with nobody in the UI, so this job ships active.
INSERT INTO scheduled_jobs (job_key, label, schedule, handler_key, is_active)
VALUES (
  'apply_effective_workforce_movements',
  'Áp dụng hiệu lực Nghỉ việc/Thuyên chuyển đến ngày hiệu lực',
  'daily',
  'APPLY_EFFECTIVE_WORKFORCE_MOVEMENTS',
  true
)
ON CONFLICT (job_key) DO NOTHING;
