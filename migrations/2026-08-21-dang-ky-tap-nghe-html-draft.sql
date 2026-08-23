-- ============================================================
-- TOMBSTONE — OBSOLETE TRAINEE-REGISTRATION HTML SEED (NEUTRALISED)
-- ------------------------------------------------------------
-- This migration ORIGINALLY seeded a hand-rebuilt five-page HTML body for
-- template "Đăng ký tập nghề" (google_doc_id 10D0tG71...) as version 1 DRAFT.
--
-- That body is OBSOLETE and seriously incomplete relative to the approved
-- document. It is the body responsible for the incorrect per-candidate PDF
-- observed in Production. It has therefore been removed from this migration so
-- it can never be re-seeded and can never silently become active again on a
-- fresh database, a restored environment, or a replayed migration run.
--
-- WHAT WAS REMOVED
--   * the five-page html_body literal
--   * its print_css literal
--   * the two orphan tax-contract placeholders it still referenced
--     (So_hop_dong_dich_vu_thue, Ngay_hop_dong_dich_vu_thue)
--
-- WHAT IS PRESERVED
--   * Existing historical rows in merge_template_versions are NOT touched.
--     Nothing here updates, archives or deletes any version row. Historical
--     versions remain readable for audit/rollback, exactly as required.
--   * merge_templates.html_enabled is still asserted, because it is a
--     capability flag (this template supports the HTML engine) and carries no
--     document content.
--
-- WHY THIS IS SAFE
--   Runtime never selects a template body implicitly. The render pipeline
--   (renderCanonicalDocument) requires an explicitly PUBLISHED canonical
--   version and otherwise fails closed with CANONICAL_TEMPLATE_NOT_PUBLISHED.
--   An obsolete historical DRAFT/ARCHIVED row can therefore never be picked up
--   automatically.
--
-- The current canonical body is introduced as a NEW DRAFT by
-- migrations/2026-08-23-trainee-registration-canonical-html-draft.sql and must
-- be Published explicitly by an operator.
--
-- Idempotent, non-destructive, no-op with respect to document content.
-- ============================================================

-- Capability flag only — no document body, no publish, no version mutation.
UPDATE merge_templates
SET html_enabled = true, updated_at = now()
WHERE google_doc_id = '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE'
  AND html_enabled = false;

-- Read-only verification: obsolete seed must never be (re)introduced.
SELECT version, status, source_docx_name
FROM merge_template_versions v
JOIN merge_templates t ON t.id = v.template_id
WHERE t.google_doc_id = '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE'
ORDER BY v.version;
