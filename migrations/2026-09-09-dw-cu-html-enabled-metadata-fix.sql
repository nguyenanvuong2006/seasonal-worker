-- ============================================================
-- DW Cũ (Tài liệu A) — enable HTML/PDF generation (2026-09, Defect 4).
-- ------------------------------------------------------------
-- REPORTED: selecting DW Cũ candidates and clicking "Tạo hồ sơ xác nhận
-- (điện tử)" fails with "Template này chưa được bật chế độ HTML/PDF."
--
-- ROOT CAUSE (confirmed via scripts/diagnose-dw-old-template-eligibility.ts
-- against real production, never via guess): merge_templates.html_enabled
-- is FALSE for DW Cũ, even though its currently PUBLISHED version (v1)
-- already carries real, complete content — html_body (13301 chars),
-- print_css (3026 chars), and a 41-field mapping_snapshot, published
-- 2026-09-09T03:14:24Z. This is a pure template-level METADATA gap, not
-- missing/broken content: createAsyncMergeJob()'s HTML_PDF eligibility gate
-- (src/lib/document-merge/async-job.ts: `if (engine === "HTML_PDF" &&
-- !forced.htmlEnabled) throw ...`) reads merge_templates.html_enabled
-- directly — it never inspects whether the published version itself has
-- real HTML content. There is no admin UI/API to toggle this column today
-- (grep confirms html_enabled is only ever READ by application code, never
-- WRITTEN by it) — a database-level fix is genuinely the only mechanism.
--
-- FIX: flip merge_templates.html_enabled to TRUE for DW Cũ only, scoped by
-- document_kind = 'A' (the schema's own documented convention: "A = Cam
-- kết / Tái ký (DW Cũ)") AND name, rather than a hardcoded row id — this
-- mission's own instructions explicitly warn not to trust a previously-
-- known id without re-checking. The diagnostic
-- (scripts/diagnose-dw-old-template-eligibility.ts) found exactly ONE row
-- matching document_kind = 'A' in production at the time of this fix, and
-- the SAME script is re-run after this migration to independently confirm
-- html_enabled actually flipped and the published version's content is
-- unaffected. Touches NO html_body/print_css/mapping_snapshot/
-- version content — pure metadata correction, no new template version. DW
-- Mới (document_kind = 'B') is never touched — this WHERE clause cannot
-- match it.
--
-- Idempotent: re-running finds html_enabled already TRUE and updates 0 rows.
-- ============================================================
UPDATE merge_templates
SET html_enabled = true,
    updated_at = now(),
    updated_by = 'migration:2026-09-09-dw-cu-html-enabled-metadata-fix'
WHERE document_kind = 'A'
  AND name = 'Đăng ký tập nghề - Quy định tập nghề (DW cũ)'
  AND html_enabled = false;
