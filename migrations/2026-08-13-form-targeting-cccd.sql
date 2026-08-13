-- Form Builder applicant targeting + exact CCCD policy.
-- Idempotent and safe for databases that still contain legacy identity values:
-- CHECK constraints are NOT VALID, so historical rows remain readable while every
-- new INSERT/UPDATE must comply. Remediate historical rows, then VALIDATE later.

ALTER TABLE form_questions
  ADD COLUMN IF NOT EXISTS visible_to_applicants boolean NOT NULL DEFAULT true;
ALTER TABLE form_questions
  ADD COLUMN IF NOT EXISTS target_audience varchar(20) NOT NULL DEFAULT 'ALL';
ALTER TABLE form_questions
  ADD COLUMN IF NOT EXISTS skip_for_returning boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'form_questions_target_audience_chk'
  ) THEN
    ALTER TABLE form_questions
      ADD CONSTRAINT form_questions_target_audience_chk
      CHECK (target_audience IN ('ALL', 'NEW_ONLY', 'RETURNING_ONLY'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'daily_applications_cccd_exact_12_chk'
  ) THEN
    ALTER TABLE daily_applications
      ADD CONSTRAINT daily_applications_cccd_exact_12_chk
      CHECK (cccd IS NOT NULL AND cccd ~ '^[0-9]{12}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dw_data_cccd_exact_12_chk'
  ) THEN
    ALTER TABLE dw_data
      ADD CONSTRAINT dw_data_cccd_exact_12_chk
      CHECK (cccd IS NOT NULL AND cccd ~ '^[0-9]{12}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'worker_profiles_cccd_exact_12_chk'
  ) THEN
    ALTER TABLE worker_profiles
      ADD CONSTRAINT worker_profiles_cccd_exact_12_chk
      CHECK (cccd IS NOT NULL AND cccd ~ '^[0-9]{12}$') NOT VALID;
  END IF;
END $$;

-- Audit historical rows before validating constraints:
-- SELECT id, cccd FROM daily_applications WHERE cccd !~ '^[0-9]{12}$';
-- SELECT id, cccd FROM dw_data WHERE cccd IS NULL OR cccd !~ '^[0-9]{12}$';
-- SELECT id, cccd FROM worker_profiles WHERE cccd !~ '^[0-9]{12}$';
--
-- After all three queries return no rows:
-- ALTER TABLE daily_applications VALIDATE CONSTRAINT daily_applications_cccd_exact_12_chk;
-- ALTER TABLE dw_data VALIDATE CONSTRAINT dw_data_cccd_exact_12_chk;
-- ALTER TABLE worker_profiles VALIDATE CONSTRAINT worker_profiles_cccd_exact_12_chk;
