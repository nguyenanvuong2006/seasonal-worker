-- ============================================================
-- TRAINEE-REGISTRATION HTML — v20 DRAFT in-place edit (NOT a new version).
-- ------------------------------------------------------------
-- Updates the EXISTING v20 DRAFT row created by
-- 2026-09-07-trainee-registration-v20-signature-and-section7-flow-draft.sql
-- (identified by its own source_docx_name, unchanged since — see
-- template-versions.ts's updateTemplateVersionDraft(), which this
-- migration mirrors exactly: same target row, same columns touched
-- (html_body/print_css/margins/updated_at), same DRAFT-only guard). This
-- is a content EDIT of that one row, not an INSERT — no v21 is created,
-- nothing is published, PUBLISHED v19 and every other version are
-- untouched.
--
-- CHANGE 1 — restore A4 margins to the canonical default 10/10/12/12mm
-- (an operator had been trying 14/14/12/12 via the newly built margin
-- controls in Template Editor; this resets that experiment back).
--
-- CHANGE 2 — insert one explicit forced page break immediately before
-- item "e. Phải đăng ký đầy đủ danh sách..." in the Trainee Regulation
-- section, so that item always starts a fresh physical A4 page. New
-- reusable template CSS class (checked against both this template's own
-- print_css and the shared renderer's utility CSS first — neither already
-- had an equivalent standalone "force a break here" class; the renderer's
-- own `.page + .page` rule is a different, sibling-combinator mechanism
-- tied to the `.page` class this template does not use, not a reusable
-- standalone class):
--     .manual-page-break { break-before: page; page-break-before: always; }
-- Applied via `<div class="manual-page-break"></div>` — no repeated <br>,
-- no empty spacer elements. Implemented ENTIRELY in this template's own
-- html_body/print_css; html-renderer.ts (the shared canonical renderer)
-- is NOT touched.
--
-- Both edits use targeted string operations (REPLACE / conditional
-- append), not a full-body overwrite, so any other content already in
-- this DRAFT (if an operator has since edited it further via Template
-- Editor) is preserved untouched. Idempotent: the html_body REPLACE and
-- the WHERE guard below only fire once — a second run is a no-op because
-- the marker div/class are already present.
--
-- Line-height, all text, all placeholders/mappings, section 7's natural
-- flow (the merged .paper from the prior migration), the signature
-- layout, and the HTML_PDF renderer are all untouched by this migration.
-- ============================================================
UPDATE merge_template_versions
SET
  html_body = REPLACE(
    html_body,
    '<div class="line justify indent">e. Phải đăng ký đầy đủ danh sách',
    '<div class="manual-page-break"></div>
  <div class="line justify indent">e. Phải đăng ký đầy đủ danh sách'
  ),
  print_css = CASE
    WHEN print_css LIKE '%.manual-page-break%' THEN print_css
    ELSE print_css || E'\n\n.manual-page-break {\n  break-before: page;\n  page-break-before: always;\n}\n'
  END,
  margin_top_mm = 10,
  margin_bottom_mm = 10,
  margin_left_mm = 12,
  margin_right_mm = 12,
  updated_at = now()
WHERE status = 'DRAFT'
  AND source_docx_name = 'trainee-registration/v20-signature-and-section7-flow-draft (page 1 signature space +~10mm; section 7 flows naturally after section 6 instead of forcing a new page)'
  AND html_body NOT LIKE '%<div class="manual-page-break"></div>%';

-- Read-only verification only. No publish, no template pointer update, no jobs.
SELECT
  version, status,
  margin_top_mm, margin_bottom_mm, margin_left_mm, margin_right_mm,
  html_body LIKE '%<div class="manual-page-break"></div>%' AS has_manual_page_break,
  print_css LIKE '%.manual-page-break%' AS has_manual_page_break_css
FROM merge_template_versions
WHERE source_docx_name = 'trainee-registration/v20-signature-and-section7-flow-draft (page 1 signature space +~10mm; section 7 flows naturally after section 6 instead of forcing a new page)';
