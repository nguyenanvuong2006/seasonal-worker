-- Migration: Effective-dated dynamic question versioning

-- 1. Add apply_from and effective_to columns
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS apply_from date;
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS effective_to date;

-- 2. Add metadata columns for aliases and export column names
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS aliases jsonb DEFAULT '[]'::jsonb;
ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS export_column_name varchar(160);

-- 3. Backfill apply_from for existing rows so they remain valid
UPDATE form_questions SET apply_from = created_at::date WHERE apply_from IS NULL;

-- 4. Drop the old unique constraint on field_key since multiple versions can exist
ALTER TABLE form_questions DROP CONSTRAINT IF EXISTS form_questions_field_key_unique;
ALTER TABLE form_questions DROP CONSTRAINT IF EXISTS form_questions_field_key_key;

-- 5. Create a new unique index on (field_key, apply_from)
CREATE UNIQUE INDEX IF NOT EXISTS form_questions_field_key_apply_from_idx ON form_questions (field_key, apply_from);
  
-- 6. Set a default so old INSERT code that omits apply_from safely defaults to today, unblocking Migration-First deployment
ALTER TABLE form_questions ALTER COLUMN apply_from SET DEFAULT CURRENT_DATE;
ALTER TABLE form_questions ALTER COLUMN apply_from SET NOT NULL;
