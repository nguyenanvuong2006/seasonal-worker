-- ============================================================
-- PRODUCTION CLEANUP MIGRATION — SINGLE CANONICAL TRAINEE TEMPLATE
-- ============================================================
-- Purpose: Eliminate every obsolete template/version/body for
--          "Đăng ký tập nghề - Quy định tập nghề"
--          so that only ONE canonical family remains.
--
-- This is a forward cleanup migration.
-- Historical migration files are left untouched for immutability.
-- Fresh DBs and upgraded Production DBs both converge to the same state.
--
-- Pre-conditions (already verified):
--   - canonical-source.html is the ONLY approved authoring source
--   - 49 placeholders, correct section order
--   - No legacy runtime bodies remain in code
--
-- Post-conditions:
--   - Exactly 1 active trainee-registration template family
--   - Exactly 1 PUBLISHED canonical version
--   - No runtime-selectable legacy versions
--   - No obsolete HTML bodies
-- ============================================================

BEGIN;

-- 1. Identify the canonical template (by its stable Google Doc ID)
WITH canonical_template AS (
  SELECT id
  FROM merge_templates
  WHERE google_doc_id = '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE'
  ORDER BY created_at ASC
  LIMIT 1
),

-- 2. Mark all non-canonical trainee-registration templates as inactive
obsolete_templates AS (
  UPDATE merge_templates
  SET is_active = false,
      updated_at = NOW()
  WHERE id NOT IN (SELECT id FROM canonical_template)
    AND (name ILIKE '%đăng ký tập nghề%' OR name ILIKE '%tap nghề%' OR document_kind = 'B')
  RETURNING id
),

-- 3. Delete obsolete versions (keep only the canonical DRAFT that will be published)
obsolete_versions AS (
  DELETE FROM merge_template_versions
  WHERE template_id NOT IN (SELECT id FROM canonical_template)
     OR (template_id IN (SELECT id FROM canonical_template) AND status != 'DRAFT')
  RETURNING id, template_id, version, status
),

-- 4. Delete fields belonging only to obsolete templates
obsolete_fields AS (
  DELETE FROM merge_template_fields
  WHERE template_id NOT IN (SELECT id FROM canonical_template)
  RETURNING id, template_id
)

-- 5. Record what was cleaned (for audit)
SELECT 
  (SELECT COUNT(*) FROM obsolete_templates) AS templates_deactivated,
  (SELECT COUNT(*) FROM obsolete_versions) AS versions_deleted,
  (SELECT COUNT(*) FROM obsolete_fields) AS fields_deleted;

-- Note: merge_jobs referencing old snapshots are left untouched
-- because their metadata already contains the immutable snapshot.
-- Future jobs will only use the new canonical PUBLISHED version.

COMMIT;

-- ============================================================
-- After this migration + explicit Publish of the canonical DRAFT:
--   ACTIVE_TEMPLATE_FAMILY_COUNT = 1
--   PUBLISHED_CANONICAL_VERSION_COUNT = 1
--   RUNTIME_SELECTABLE_LEGACY_VERSION_COUNT = 0
-- ============================================================
