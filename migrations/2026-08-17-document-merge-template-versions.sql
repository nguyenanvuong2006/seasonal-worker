-- ============================================================
-- DOCUMENT MERGE — TEMPLATE VERSIONING (Phase 3)
-- ------------------------------------------------------------
-- merge_templates.current_published_version: version PUBLISHED đang
-- được dùng để render (điểm vào duy nhất cho engine HTML_PDF).
-- NULL = chưa có version HTML được publish.
--
-- NGUYÊN TẮC AN TOÀN: non-destructive, idempotent.
-- ============================================================
ALTER TABLE merge_templates ADD COLUMN IF NOT EXISTS current_published_version integer;

-- ============================================================
-- Xong.
-- ============================================================
