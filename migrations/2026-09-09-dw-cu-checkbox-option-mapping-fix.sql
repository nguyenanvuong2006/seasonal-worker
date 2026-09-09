-- ============================================================
-- DW CŨ (Tài liệu A) — fix checkbox/option field mapping (2026-09).
-- ------------------------------------------------------------
-- REPORTED: DW Cũ pages 1-2 were copied from DW Mới (Tài liệu B), but DW Cũ
-- renders option labels as plain text ("Không   Có") while DW Mới renders
-- them with the checkbox glyph ("☐ Không   ☒ Có").
--
-- ROOT CAUSE (confirmed via scripts/diagnose-dw-cu-checkbox-fields.mjs
-- against real production, never via guess):
-- Both templates' html_body carry the SAME 22 checkbox placeholder tokens
-- verbatim (e.g. <<Tien_an_tien_su_Khong>>/<<Tien_an_tien_su_Co>>,
-- <<TKNH_Chua_co>>/<<TKNH_Da_co>>, <<Khu_vuc_Da_Lat>>/... — the html_body
-- itself was correctly copied, matching the report). The glyph itself is
-- NEVER hardcoded in html_body for either template — it comes from
-- data-resolver.ts's resolveCheckboxOption(), reached only when
-- merge_template_fields.source_type = 'CHECKBOX_OPTION' (it reads
-- source_path off the record, compares it against option_value, and
-- returns the literal ☒/☐ glyph — completely independent of format_type).
--
-- DW Mới's merge_template_fields correctly map all 22 placeholders as
-- CHECKBOX_OPTION with the right source_path/option_value pair per option.
-- DW Cũ's merge_template_fields map the SAME 22 placeholders as CORE_FIELD
-- with source_entity/source_field/source_path/option_value ALL NULL — so
-- resolveFieldValue() falls into resolveCoreField(), reads an empty
-- source_path, gets no value, and returns '' (via fallback_value, also
-- null). The result: the checkbox glyph position renders as nothing,
-- leaving only the static "Không"/"Có" text already in html_body visible
-- — exactly the reported symptom. This is a MAPPING bug only; html_body/
-- print_css are untouched by this migration (no wording/layout change).
--
-- FIX: for exactly these 22 placeholders on DW Cũ's template (found by
-- google_doc_id, not a hardcoded row id), copy DW Mới's exact working
-- source_path/option_value pairs (verbatim — including DW Mới's own
-- "declaredType" and "customAnswers.xxx" source_path conventions, not
-- invented) and set source_type = 'CHECKBOX_OPTION', format_type = 'RAW'
-- (format_type is irrelevant to resolveCheckboxOption() but 'RAW' matches
-- DW Mới's own stored value for parity). No other DW Cũ field is touched
-- (WHERE scopes to template_id AND this exact placeholder list).
--
-- DW Cũ's currently PUBLISHED version (v1) already has a non-empty
-- mapping_snapshot — draft-preview.ts's selectPreviewMappings() PREFERS
-- that FROZEN snapshot over live merge_template_fields whenever it is
-- non-empty (matches publishTemplateVersion()'s own contract: mapping is
-- frozen at publish time). Updating merge_template_fields alone would
-- therefore have ZERO visible effect on the current PUBLISHED version —
-- Preview/merge would keep reading the stale, wrong snapshot. So this
-- migration ALSO regenerates mapping_snapshot for DW Cũ's PUBLISHED
-- version from the now-corrected merge_template_fields, using the EXACT
-- same shape publishTemplateVersion() itself builds (placeholder/
-- sourceType/sourceEntity/sourceField/sourcePath/optionValue/formatType/
-- fallbackValue/isRequired, non-orphaned fields only) — this is a
-- corrective fix of a wrong FROZEN MAPPING, not a change to the published
-- document's wording/layout/HTML/CSS, which are left untouched. DW Mới is
-- never touched by this migration (target_template scopes to DW Cũ's own
-- google_doc_id only).
--
-- Idempotent: re-running sets the same 22 rows to the same target values
-- and regenerates mapping_snapshot from the (by then already-correct)
-- merge_template_fields — a no-op end state on a second run.
-- ============================================================
WITH target_template AS (
  SELECT id FROM merge_templates
  WHERE google_doc_id = '1l3BpzoXcW2vvOa9gAZ0vF_kEGeq_U3NEvXdR8mwcYL4'
  ORDER BY created_at ASC LIMIT 1
),
checkbox_mapping (placeholder, source_path, option_value) AS (
  VALUES
    ('Cong_viec_hien_tai_Khac', 'customAnswers.cong_viec_hien_tai', 'Khác'),
    ('Cong_viec_hien_tai_Sinh_vien', 'customAnswers.cong_viec_hien_tai', 'Sinh viên'),
    ('Da_tung_lam_DHF_Co', 'declaredType', 'OLD'),
    ('Da_tung_lam_DHF_Khong', 'declaredType', 'NEW'),
    ('Khu_vuc_Da_Lat', 'customAnswers.khu_vuc_lam_viec_truoc_day', 'Đà Lạt'),
    ('Khu_vuc_Da_Quy', 'customAnswers.khu_vuc_lam_viec_truoc_day', 'Đa Quý'),
    ('Khu_vuc_Da_Ron', 'customAnswers.khu_vuc_lam_viec_truoc_day', 'Đạ Ròn'),
    ('Khu_vuc_Khac', 'customAnswers.khu_vuc_lam_viec_truoc_day', 'Khác'),
    ('Khu_vuc_Lam_Ha', 'customAnswers.khu_vuc_lam_viec_truoc_day', 'Lâm Hà'),
    ('Loai_cong_viec_Cong_nhan', 'customAnswers.loai_cong_viec_truoc_day', 'Công nhân'),
    ('Loai_cong_viec_Lao_dong_tap_nghe', 'customAnswers.loai_cong_viec_truoc_day', 'Lao động tập nghề'),
    ('Loai_cong_viec_Nhan_vien', 'customAnswers.loai_cong_viec_truoc_day', 'Nhân viên'),
    ('TKNH_Chua_co', 'customAnswers.tinh_trang_tknh', 'Chưa có'),
    ('TKNH_Da_co', 'customAnswers.tinh_trang_tknh', 'Đã có'),
    ('Tap_nghe_Ban_hang', 'customAnswers.tap_nghe_nguyen_vong', 'Bán hàng'),
    ('Tap_nghe_Dong_goi', 'customAnswers.tap_nghe_nguyen_vong', 'Đóng gói'),
    ('Tap_nghe_Khac', 'customAnswers.tap_nghe_nguyen_vong', 'Khác'),
    ('Tap_nghe_Trong_cham_soc_thu_hoach', 'customAnswers.tap_nghe_nguyen_vong', 'Trồng, chăm sóc, thu hoạch'),
    ('Thu_nhap_Chi_DHF', 'customAnswers.nguon_thu_nhap', 'Chỉ phát sinh tại Dalat Hasfarm'),
    ('Thu_nhap_Ngoai_DHF', 'customAnswers.nguon_thu_nhap', 'Phát sinh ngoài Dalat Hasfarm'),
    ('Tien_an_tien_su_Co', 'customAnswers.tien_an_tien_su', 'Có'),
    ('Tien_an_tien_su_Khong', 'customAnswers.tien_an_tien_su', 'Không')
)
UPDATE merge_template_fields AS f
SET
  source_type = 'CHECKBOX_OPTION',
  source_entity = NULL,
  source_field = NULL,
  source_path = m.source_path,
  option_value = m.option_value,
  format_type = 'RAW',
  updated_at = now()
FROM target_template t, checkbox_mapping m
WHERE f.template_id = t.id
  AND f.placeholder = m.placeholder;

-- Regenerate mapping_snapshot for DW Cũ's PUBLISHED version from the
-- now-corrected merge_template_fields — same shape/filter
-- publishTemplateVersion() itself uses (non-orphaned fields only). Only
-- the PUBLISHED row (if any) is touched; DRAFT/ARCHIVED rows keep whatever
-- mapping_snapshot they already have (DRAFT is always [] until its own
-- publish; ARCHIVED is historical and must stay exactly as issued).
WITH target_template AS (
  SELECT id, current_published_version FROM merge_templates
  WHERE google_doc_id = '1l3BpzoXcW2vvOa9gAZ0vF_kEGeq_U3NEvXdR8mwcYL4'
  ORDER BY created_at ASC LIMIT 1
),
regenerated AS (
  SELECT
    t.id AS template_id,
    t.current_published_version,
    jsonb_agg(
      jsonb_build_object(
        'placeholder', f.placeholder,
        'sourceType', f.source_type,
        'sourceEntity', f.source_entity,
        'sourceField', f.source_field,
        'sourcePath', f.source_path,
        'optionValue', f.option_value,
        'formatType', f.format_type,
        'fallbackValue', f.fallback_value,
        'isRequired', f.is_required
      )
      ORDER BY f.placeholder
    ) AS snapshot
  FROM target_template t
  JOIN merge_template_fields f ON f.template_id = t.id AND f.is_orphaned = false
  GROUP BY t.id, t.current_published_version
)
UPDATE merge_template_versions v
SET mapping_snapshot = r.snapshot, updated_at = now()
FROM regenerated r
WHERE v.template_id = r.template_id
  AND v.version = r.current_published_version
  AND v.status = 'PUBLISHED';

-- Read-only verification only. No publish, no template pointer update, no jobs.
SELECT f.placeholder, f.source_type, f.source_path, f.option_value, f.format_type
FROM merge_template_fields f
JOIN merge_templates t ON t.id = f.template_id
WHERE t.google_doc_id = '1l3BpzoXcW2vvOa9gAZ0vF_kEGeq_U3NEvXdR8mwcYL4'
  AND f.placeholder IN (
    'Cong_viec_hien_tai_Khac', 'Cong_viec_hien_tai_Sinh_vien', 'Da_tung_lam_DHF_Co', 'Da_tung_lam_DHF_Khong',
    'Khu_vuc_Da_Lat', 'Khu_vuc_Da_Quy', 'Khu_vuc_Da_Ron', 'Khu_vuc_Khac', 'Khu_vuc_Lam_Ha',
    'Loai_cong_viec_Cong_nhan', 'Loai_cong_viec_Lao_dong_tap_nghe', 'Loai_cong_viec_Nhan_vien',
    'TKNH_Chua_co', 'TKNH_Da_co', 'Tap_nghe_Ban_hang', 'Tap_nghe_Dong_goi', 'Tap_nghe_Khac',
    'Tap_nghe_Trong_cham_soc_thu_hoach', 'Thu_nhap_Chi_DHF', 'Thu_nhap_Ngoai_DHF',
    'Tien_an_tien_su_Co', 'Tien_an_tien_su_Khong'
  )
ORDER BY f.placeholder;

SELECT v.version, v.status, jsonb_array_length(v.mapping_snapshot) AS mapping_snapshot_count
FROM merge_template_versions v
JOIN merge_templates t ON t.id = v.template_id
WHERE t.google_doc_id = '1l3BpzoXcW2vvOa9gAZ0vF_kEGeq_U3NEvXdR8mwcYL4'
  AND v.status = 'PUBLISHED';
