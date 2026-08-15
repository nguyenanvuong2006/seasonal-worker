-- ============================================================
-- RECRUIT MERGE + KÝ NHẬN HỒ SƠ TẬP NGHỀ
-- Dual-template (Tài liệu A / Tài liệu B), đẩy link tới /lookup,
-- chữ ký điện tử + câu trả lời xác nhận.
-- An toàn chạy lại nhiều lần.
-- ============================================================

ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS merged_doc_url text;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS merged_doc_pdf_url text;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS merged_template_id uuid;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS document_sent_at timestamptz;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS signature_data_url text;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS signature_confirmed_at timestamptz;
ALTER TABLE daily_applications ADD COLUMN IF NOT EXISTS confirmed_answers jsonb DEFAULT '{}';

CREATE INDEX IF NOT EXISTS daily_app_document_sent_idx
  ON daily_applications (document_sent_at)
  WHERE document_sent_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS daily_app_signature_idx
  ON daily_applications (signature_confirmed_at)
  WHERE signature_confirmed_at IS NOT NULL;

ALTER TABLE merge_templates ADD COLUMN IF NOT EXISTS document_kind varchar(16) NOT NULL DEFAULT 'GENERIC';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merge_templates_document_kind_chk') THEN
    ALTER TABLE merge_templates ADD CONSTRAINT merge_templates_document_kind_chk
      CHECK (document_kind IN ('A', 'B', 'GENERIC'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS merge_template_kind_idx ON merge_templates (document_kind, is_active);
