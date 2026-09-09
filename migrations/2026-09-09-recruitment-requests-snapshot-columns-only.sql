-- ============================================================
-- 2026-09-09 — RECRUITMENT_REQUESTS SNAPSHOT COLUMNS (SCHEMA-ONLY HOTFIX)
-- ------------------------------------------------------------
-- PRODUCTION INCIDENT: "Recruitment Requests" list returns HTTP 500;
-- "Workforce Request" page fails with "Unexpected end of JSON input".
--
-- ROOT CAUSE (confirmed via scripts/diagnose-recruitment-workforce-500.ts
-- against real production, never via guess): migrations/2026-08-19-
-- recruitment-snapshot-reconciliation.sql was written to the repo but
-- never actually applied to Production (non-Document-Merge migrations are
-- applied manually per docs/PRODUCTION-DEPLOY.md — no CI runs them). Its
-- ADD COLUMN block is what src/db/schema.ts's `recruitmentRequests` table
-- has always declared; without it, Production's real table is missing
-- male_current_at_start / female_current_at_start / total_current_at_start
-- / snapshot_at. Both listRecruitmentRequests() (recruitment-request.ts)
-- and listWorkforceRequests() (workforce-request.ts) do a full-row SELECT
-- on this table, so EVERY call throws Postgres "column ... does not
-- exist" — an uncaught exception with no try/catch in either route,
-- producing an empty/non-JSON 500 response.
--
-- SCOPE — deliberately NARROWER than the original migration: this file
-- contains ONLY the four ADD COLUMN IF NOT EXISTS statements (byte-
-- identical types/defaults/nullability to migrations/2026-08-19-
-- recruitment-snapshot-reconciliation.sql's own Part 1). It intentionally
-- SKIPS that file's Part 2 (backfilling snapshot values from current
-- workforce state) and Part 3 (recomputing male_balance/female_balance/
-- total_balance for every existing request) — both are real, visible
-- business-data changes to existing recruitment requests, not required to
-- fix the crash (the live KPI shown in both UIs is computed by
-- computeRequestKpi()/batchComputeRequestKpis() at read time, never read
-- from these stored columns), and out of scope for an infrastructure
-- incident fix. New columns default to 0 (integers) / NULL (snapshot_at)
-- for every existing row — a deliberate placeholder state, not a
-- reconciled one. Applying the full backfill+recompute later remains a
-- separate, deliberate decision — see the original migration file.
--
-- SAFETY: purely additive (ADD COLUMN IF NOT EXISTS with a constant
-- DEFAULT), no data mutation of any existing row's business fields, no
-- DROP/DELETE/TRUNCATE anywhere. Idempotent — re-running finds the
-- columns already present and is a no-op.
-- ============================================================

ALTER TABLE recruitment_requests
  ADD COLUMN IF NOT EXISTS male_current_at_start   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS female_current_at_start integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_current_at_start  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snapshot_at             timestamptz;

COMMENT ON COLUMN recruitment_requests.male_current_at_start IS
  'Snapshot CỐ ĐỊNH: số worker Nam ACTIVE tại Department vào thời điểm Request được mở. KHÔNG recompute lại — chỉ Admin explicit correction mới được sửa. Cột thêm 2026-09-09 (schema-only hotfix) — giá trị mặc định 0 cho các request hiện có; backfill thật sự vẫn nằm ở migrations/2026-08-19-recruitment-snapshot-reconciliation.sql, chưa chạy.';
COMMENT ON COLUMN recruitment_requests.female_current_at_start IS
  'Snapshot CỐ ĐỊNH: số worker Nữ ACTIVE tại Department vào thời điểm Request được mở. Cột thêm 2026-09-09 (schema-only hotfix) — xem ghi chú ở male_current_at_start.';
COMMENT ON COLUMN recruitment_requests.total_current_at_start IS
  'Snapshot CỐ ĐỊNH: tổng worker ACTIVE tại Department vào thời điểm Request được mở. Cột thêm 2026-09-09 (schema-only hotfix) — xem ghi chú ở male_current_at_start.';
COMMENT ON COLUMN recruitment_requests.snapshot_at IS
  'Thời điểm snapshot được chụp. NULL = chưa từng snapshot. Cột thêm 2026-09-09 (schema-only hotfix) — vẫn NULL cho toàn bộ request hiện có cho tới khi backfill thật sự (migrations/2026-08-19-recruitment-snapshot-reconciliation.sql) được chạy như một quyết định riêng.';
