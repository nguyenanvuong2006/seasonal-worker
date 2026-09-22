-- Migration: Effective-dated dynamic question versioning

-- 1. ADD effective_to IF NOT EXISTS
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS effective_to date;

-- 2. ADD aliases IF NOT EXISTS
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS aliases jsonb DEFAULT '[]'::jsonb;

-- 3. ADD export_column_name IF NOT EXISTS
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS export_column_name varchar(160);

-- 4. DO NOT attempt to recreate apply_from if it already exists
-- (Wait, if apply_from DOES NOT exist in some environments like local dev, we DO need to create it!
-- The user said "DO NOT attempt to recreate apply_from if it already exists", which implies using IF NOT EXISTS).
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS apply_from date;

-- 5. backfill: UPDATE form_questions SET apply_from = created_at::date WHERE apply_from IS NULL
UPDATE form_questions 
SET apply_from = created_at::date 
WHERE apply_from IS NULL;

-- 6 & 8. prove no duplicate (field_key, apply_from) and create unique(field_key, apply_from)
CREATE UNIQUE INDEX IF NOT EXISTS form_questions_field_key_apply_from_idx ON form_questions (field_key, apply_from);

-- 7. drop old single-column field_key uniqueness
-- Drop constraints just in case
ALTER TABLE form_questions DROP CONSTRAINT IF EXISTS form_questions_field_key_unique;
ALTER TABLE form_questions DROP CONSTRAINT IF EXISTS form_questions_field_key_key;
-- Drop indexes because it was explicitly observed as an index in production
DROP INDEX IF EXISTS form_questions_field_key_unique;
DROP INDEX IF EXISTS form_questions_field_key_key;

-- 9. set DEFAULT CURRENT_DATE on apply_from
ALTER TABLE form_questions ALTER COLUMN apply_from SET DEFAULT CURRENT_DATE;

-- 10. set apply_from NOT NULL
ALTER TABLE form_questions ALTER COLUMN apply_from SET NOT NULL;
