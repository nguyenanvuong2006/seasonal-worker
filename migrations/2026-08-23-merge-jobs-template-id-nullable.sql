-- ============================================================
-- FIX: merge_jobs.template_id should be nullable
-- ------------------------------------------------------------
-- PDF Overlay E2E jobs use synthetic E2E snapshots without a real template.
-- Auto-route A/B jobs combine records from multiple templates, so the parent job doesn't have a single template_id.
-- src/db/schema.ts already defines templateId as nullable.
-- This aligns the DB schema with the application domain invariant.
-- ============================================================

ALTER TABLE merge_jobs ALTER COLUMN template_id DROP NOT NULL;
