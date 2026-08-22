-- ============================================================
-- PDF OVERLAY ENGINE — FOUNDATION (PR1)
-- ------------------------------------------------------------
-- Nền tảng dữ liệu cho kiến trúc "Full-Document PDF Coordinate
-- Overlay". TÁCH RIÊNG hoàn toàn khỏi merge_template_versions
-- (HTML DRAFT/PUBLISHED) — HTML DRAFT v3 KHÔNG bị đụng tới.
--
-- NGUYÊN TẮC AN TOÀN:
--   - KHÔNG destructive: CREATE TABLE IF NOT EXISTS + CREATE INDEX.
--   - KHÔNG xoá/drop bảng/cột/dữ liệu hiện có.
--   - Idempotent: chạy lại nhiều lần không lỗi.
--   - GOOGLE_DOCS engine không bị ảnh hưởng gì.
-- ============================================================

-- ============================================================
-- pdf_template_versions — PDF nền (background) bất biến, version hoá.
--   1 version = 1 bản PDF đã blanked (placeholder đã xoá) + sha256
--   + page_count + page_layout. Chỉ 1 PUBLISHED/template.
-- ============================================================
CREATE TABLE IF NOT EXISTS pdf_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES merge_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'DRAFT', -- DRAFT | PUBLISHED | ARCHIVED
  pdf_storage_key text NOT NULL,
  sha256 varchar(64) NOT NULL,
  page_count integer NOT NULL,
  page_layout jsonb NOT NULL DEFAULT '[]',
  source_note text,
  created_by varchar(64) NOT NULL,
  published_at timestamptz,
  archived_at timestamptz,
  superseded_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
CREATE INDEX IF NOT EXISTS pdf_template_version_status_idx
  ON pdf_template_versions (template_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS pdf_template_version_published_uq
  ON pdf_template_versions (template_id) WHERE status = 'PUBLISHED';

-- ============================================================
-- pdf_field_positions — bản đồ tọa độ theo version.
--   Một placeholder có thể có NHIỀU position (cùng/khác page).
--   x/y = PDF points, gốc bottom-left (xem pdf-overlay/geometry.ts).
-- ============================================================
CREATE TABLE IF NOT EXISTS pdf_field_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pdf_template_version_id uuid NOT NULL REFERENCES pdf_template_versions(id) ON DELETE CASCADE,
  placeholder varchar(255) NOT NULL,
  page_number integer NOT NULL, -- 1-based
  x double precision NOT NULL,
  y double precision NOT NULL,
  width double precision NOT NULL,
  height double precision NOT NULL,
  type varchar(24) NOT NULL DEFAULT 'TEXT',
  font_size double precision NOT NULL DEFAULT 10,
  min_font_size double precision,
  font_family varchar(64),
  align varchar(8) NOT NULL DEFAULT 'left',
  valign varchar(8) NOT NULL DEFAULT 'top',
  multiline boolean NOT NULL DEFAULT false,
  max_lines integer,
  rotation integer NOT NULL DEFAULT 0,
  render_order integer NOT NULL DEFAULT 0,
  is_required boolean NOT NULL DEFAULT false,
  whiteout boolean NOT NULL DEFAULT false,
  checkbox_style varchar(16),
  option_value varchar(255),
  source_key varchar(255),
  overflow_policy varchar(16) NOT NULL DEFAULT 'FAIL',
  static_text text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pdf_template_version_id, placeholder, page_number, x, y)
);
CREATE INDEX IF NOT EXISTS pdf_field_position_page_idx
  ON pdf_field_positions (pdf_template_version_id, page_number, render_order);

-- Xong. Không thay đổi dữ liệu hiện có.
