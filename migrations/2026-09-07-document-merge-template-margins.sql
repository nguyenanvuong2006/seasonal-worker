-- ============================================================
-- DOCUMENT MERGE — admin-configurable A4 print margins per template version
-- ------------------------------------------------------------
-- Root cause fixed alongside this migration (see html-renderer.ts): margins
-- were applied TWICE (once by `@page margin`, once by template wrapper
-- padding), roughly doubling visible whitespace and — because the wrapper's
-- own width/height then overflowed the page's already-shrunk printable
-- area — pushing small trailing content fragments onto near-empty extra
-- pages. `@page` now always carries margin:0; these four columns are the
-- ONLY place page margin is ever applied (see pageGeometryCss()).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + guarded CHECK constraints) — safe to
-- run multiple times, including on production, without seeding/mutating any
-- row content beyond the new columns' defaults.
--
-- Defaults (10mm top/bottom, 12mm left/right) match the canonical geometry
-- in html-renderer.ts's DEFAULT_PAGE_MARGINS — every existing row (any
-- status: DRAFT/PUBLISHED/ARCHIVED) receives these via the column DEFAULT,
-- which is exactly the corrected geometry, not the old buggy doubled value —
-- "backward compatible" here means "does not error/crash on existing rows",
-- not "preserves the defect".
-- ============================================================

ALTER TABLE merge_template_versions
  ADD COLUMN IF NOT EXISTS margin_top_mm INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS margin_bottom_mm INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS margin_left_mm INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS margin_right_mm INTEGER NOT NULL DEFAULT 12;

-- Defense in depth (primary validation lives in template-versions.ts):
-- no negative margin, no margin so large the printable A4 area collapses.
-- 0-60mm per side; combined horizontal/vertical margin must leave a usable
-- printable area (>= 30mm width, >= 40mm height out of 210mm x 297mm).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'merge_template_versions_margin_range_chk'
  ) THEN
    ALTER TABLE merge_template_versions
      ADD CONSTRAINT merge_template_versions_margin_range_chk CHECK (
        margin_top_mm BETWEEN 0 AND 60 AND
        margin_bottom_mm BETWEEN 0 AND 60 AND
        margin_left_mm BETWEEN 0 AND 60 AND
        margin_right_mm BETWEEN 0 AND 60 AND
        (margin_left_mm + margin_right_mm) <= 180 AND
        (margin_top_mm + margin_bottom_mm) <= 257
      );
  END IF;
END $$;
