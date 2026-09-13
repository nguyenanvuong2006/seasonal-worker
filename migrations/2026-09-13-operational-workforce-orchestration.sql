-- MISSION E — OPERATIONAL WORKFORCE ORCHESTRATION (2026-09-13).
--
-- Internal DW Code (Mã số công nhật, dw_data.code) and IT Code
-- (dw_data.it_code) were audited and confirmed to be plain free-text
-- varchar(40) columns with ZERO pool/sequence/assignment-history
-- infrastructure anywhere in the schema. This migration is purely
-- ADDITIVE: seven brand-new tables, zero changes to any existing table,
-- zero backfill of historical dw_data.code/it_code values (they may not
-- conform to any prefix scheme — forcing them into the new pool would
-- risk fabricating history that never existed). dw_data.code/it_code
-- remain exactly what every existing screen already reads; the new
-- assignment services write through them as mirrors going forward.
--
-- Tables:
--   dw_code_locations       location-aware DW Code generator config,
--                           soft-linked to an existing organization_units
--                           row (no duplicate location master)
--   dw_codes                the DW Code pool (one row per code ever
--                           generated)
--   dw_code_assignments     append-only DW Code assign/release history
--   it_code_assignments     append-only IT Code assign/release history
--                           (independent lifecycle, no pool/sequence —
--                           IT Code values come from the attendance
--                           system, never generated here)
--   same_day_lifecycle_events  NO_SHOW / DECLINED_AT_START /
--                           STARTED_THEN_LEFT manager report + exact
--                           orchestrated-effect audit trail
--   meal_cutoff_settings    singleton config row (mirrors the existing
--                           branding_settings fixed-id-row pattern)
--   meal_exclusions         per (dailyApplication, date) meal-eligibility
--                           exclusion marker — never changes the
--                           canonical Báo cơm eligibility RULE itself
--
-- Idempotent by construction (CREATE TABLE/INDEX IF NOT EXISTS). Never
-- drops or alters an existing column. Run via the canonical
-- single-migration runner (scripts/run-migration.mjs) — NOT executed
-- against Production by this mission; owner approval required first.

CREATE TABLE IF NOT EXISTS dw_code_locations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_unit_id uuid NOT NULL REFERENCES organization_units(id) ON DELETE RESTRICT,
  name                varchar(160) NOT NULL,
  prefix              varchar(8) NOT NULL,
  sequence_digits     integer NOT NULL DEFAULT 5,
  separator           varchar(4) NOT NULL DEFAULT '-',
  suffix              varchar(8) NOT NULL DEFAULT 'D',
  start_number        integer NOT NULL DEFAULT 1,
  next_sequence       integer NOT NULL DEFAULT 1,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          varchar(64),
  updated_by          varchar(64)
);

CREATE UNIQUE INDEX IF NOT EXISTS dw_code_location_org_unit_uq ON dw_code_locations (organization_unit_id);
CREATE UNIQUE INDEX IF NOT EXISTS dw_code_location_prefix_uq ON dw_code_locations (prefix);

CREATE TABLE IF NOT EXISTS dw_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL REFERENCES dw_code_locations(id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL,
  code            varchar(40) NOT NULL,
  status          varchar(16) NOT NULL DEFAULT 'AVAILABLE', -- AVAILABLE | ASSIGNED | RETIRED
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dw_code_location_sequence_uq ON dw_codes (location_id, sequence_number);
CREATE UNIQUE INDEX IF NOT EXISTS dw_code_code_uq ON dw_codes (code);
CREATE INDEX IF NOT EXISTS dw_code_location_status_idx ON dw_codes (location_id, status);

CREATE TABLE IF NOT EXISTS dw_code_assignments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id               uuid NOT NULL REFERENCES dw_codes(id) ON DELETE RESTRICT,
  worker_id             uuid NOT NULL REFERENCES worker_profiles(id) ON DELETE RESTRICT,
  employment_session_id uuid NOT NULL REFERENCES employment_sessions(id) ON DELETE RESTRICT,
  dw_data_id            uuid NOT NULL REFERENCES dw_data(id) ON DELETE RESTRICT,
  assigned_at           timestamptz NOT NULL DEFAULT now(),
  assigned_by           varchar(64) NOT NULL,
  released_at           timestamptz,
  released_by           varchar(64),
  release_reason        varchar(32), -- NO_SHOW | DECLINED_AT_START | STARTED_THEN_LEFT | EMPLOYMENT_ENDED | CROSS_LOCATION_TRANSFER | MANUAL_CORRECTION
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dw_code_assignment_one_active_per_code_uq ON dw_code_assignments (code_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dw_code_assignment_one_active_per_worker_uq ON dw_code_assignments (worker_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS dw_code_assignment_session_idx ON dw_code_assignments (employment_session_id);
CREATE INDEX IF NOT EXISTS dw_code_assignment_dw_data_idx ON dw_code_assignments (dw_data_id);
CREATE INDEX IF NOT EXISTS dw_code_assignment_worker_idx ON dw_code_assignments (worker_id);

CREATE TABLE IF NOT EXISTS it_code_assignments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  it_code               varchar(40) NOT NULL,
  worker_id             uuid NOT NULL REFERENCES worker_profiles(id) ON DELETE RESTRICT,
  employment_session_id uuid NOT NULL REFERENCES employment_sessions(id) ON DELETE RESTRICT,
  dw_data_id            uuid NOT NULL REFERENCES dw_data(id) ON DELETE RESTRICT,
  assigned_at           timestamptz NOT NULL DEFAULT now(),
  assigned_by           varchar(64) NOT NULL,
  released_at           timestamptz,
  released_by           varchar(64),
  release_reason        varchar(32),
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS it_code_assignment_one_active_per_code_uq ON it_code_assignments (it_code) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS it_code_assignment_one_active_per_worker_uq ON it_code_assignments (worker_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS it_code_assignment_session_idx ON it_code_assignments (employment_session_id);
CREATE INDEX IF NOT EXISTS it_code_assignment_dw_data_idx ON it_code_assignments (dw_data_id);
CREATE INDEX IF NOT EXISTS it_code_assignment_worker_idx ON it_code_assignments (worker_id);

CREATE TABLE IF NOT EXISTS same_day_lifecycle_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_application_id     uuid NOT NULL REFERENCES daily_applications(id) ON DELETE RESTRICT,
  employment_session_id    uuid NOT NULL REFERENCES employment_sessions(id) ON DELETE RESTRICT,
  worker_id                uuid NOT NULL REFERENCES worker_profiles(id) ON DELETE RESTRICT,
  dept_id                  uuid REFERENCES departments(id) ON DELETE RESTRICT,
  outcome                  varchar(24) NOT NULL, -- NO_SHOW | DECLINED_AT_START | STARTED_THEN_LEFT
  event_at                 timestamptz NOT NULL,
  reason                   text,
  reported_by              varchar(64) NOT NULL,
  reported_at              timestamptz NOT NULL DEFAULT now(),
  meal_action              varchar(32) NOT NULL DEFAULT 'NOT_APPLICABLE', -- NOT_APPLICABLE | CANCELLED_BEFORE_CUTOFF | REPORTED_AFTER_MEAL_CUTOFF
  dw_code_released         boolean NOT NULL DEFAULT false,
  it_code_released         boolean NOT NULL DEFAULT false,
  request_allocation_ended boolean NOT NULL DEFAULT false,
  planning_allocation_ended boolean NOT NULL DEFAULT false,
  movement_id              uuid REFERENCES workforce_movements(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS same_day_event_session_uq ON same_day_lifecycle_events (employment_session_id);
CREATE INDEX IF NOT EXISTS same_day_event_dept_idx ON same_day_lifecycle_events (dept_id, event_at);
CREATE INDEX IF NOT EXISTS same_day_event_worker_idx ON same_day_lifecycle_events (worker_id);

CREATE TABLE IF NOT EXISTS meal_cutoff_settings (
  id          varchar(20) PRIMARY KEY DEFAULT 'default',
  cutoff_time varchar(5) NOT NULL DEFAULT '10:00',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  varchar(64)
);

INSERT INTO meal_cutoff_settings (id, cutoff_time)
VALUES ('default', '10:00')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS meal_exclusions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_application_id uuid NOT NULL REFERENCES daily_applications(id) ON DELETE RESTRICT,
  exclude_date         date NOT NULL,
  reason               varchar(32) NOT NULL, -- NO_SHOW | DECLINED_AT_START | STARTED_THEN_LEFT | MANUAL_CORRECTION
  excluded_by          varchar(64) NOT NULL,
  excluded_at          timestamptz NOT NULL DEFAULT now(),
  same_day_event_id    uuid REFERENCES same_day_lifecycle_events(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS meal_exclusion_app_date_uq ON meal_exclusions (daily_application_id, exclude_date);
CREATE INDEX IF NOT EXISTS meal_exclusion_date_idx ON meal_exclusions (exclude_date);

-- Rollback (manual, if ever needed — additive-only, so a rollback is just dropping these 7 tables):
-- DROP TABLE IF EXISTS meal_exclusions;
-- DROP TABLE IF EXISTS meal_cutoff_settings;
-- DROP TABLE IF EXISTS same_day_lifecycle_events;
-- DROP TABLE IF EXISTS it_code_assignments;
-- DROP TABLE IF EXISTS dw_code_assignments;
-- DROP TABLE IF EXISTS dw_codes;
-- DROP TABLE IF EXISTS dw_code_locations;

-- Post-deploy verification (manual):
-- SELECT count(*) FROM dw_code_locations;
-- SELECT count(*) FROM dw_codes;
-- SELECT count(*) FROM dw_code_assignments;
-- SELECT count(*) FROM it_code_assignments;
-- SELECT count(*) FROM same_day_lifecycle_events;
-- SELECT * FROM meal_cutoff_settings;
-- SELECT count(*) FROM meal_exclusions;
