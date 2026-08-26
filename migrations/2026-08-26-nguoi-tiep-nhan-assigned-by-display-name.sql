-- ============================================================
-- MIGRATION — 2026-08-26 — Nguoi_tiep_nhan → assignment actor
-- ============================================================
-- "Người tiếp nhận" must show WHO XẾP VIỆC (assigned the worker), frozen at
-- assignment time — NOT the merge operator.
--
-- This updates the CURRENT mapping only (merge_template_fields). Historical
-- PUBLISHED snapshots (merge_template_versions.mapping_snapshot) are NOT
-- touched; frozen v11/v7 snapshots keep their original CURRENT_USER_NAME
-- semantics until an operator re-publishes.
--
-- Safe / idempotent:
--   * Single additive semantic change on one row.
--   * No INSERT/DELETE/DROP, no data-destructive UPDATE.
--   * Re-running is a no-op (WHERE source_field = 'CURRENT_USER_NAME' no
--     longer matches after the first run).
-- ============================================================

UPDATE merge_template_fields mf
SET source_field = 'ASSIGNED_BY_DISPLAY_NAME',
    updated_at = now()
FROM merge_templates t
WHERE mf.template_id = t.id
  AND t.google_doc_id = '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE'
  AND mf.placeholder = 'Nguoi_tiep_nhan'
  AND mf.source_type = 'SYSTEM_FIELD'
  AND mf.source_field = 'CURRENT_USER_NAME';
