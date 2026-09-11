-- ============================================================
-- SCHEMA MIGRATIONS LEDGER (Migration Governance & Production Schema
-- Reconciliation)
-- ------------------------------------------------------------
-- Governance-ONLY table — never references or touches any business table,
-- never stores PII, never gets a foreign key from a business table pointing
-- at it. One row per migration file that has actually been executed through
-- the governance runner (scripts/lib/migration-ledger.mjs), keyed by the
-- migration's exact, stable filename.
--
-- BOOTSTRAP CONTRACT (see docs/PRODUCTION-DEPLOY.md "Migration governance"):
-- this exact file is the ONE canonical bootstrap SQL. It is executed
-- directly, unconditionally, and idempotently (CREATE TABLE IF NOT EXISTS)
-- by ensureSchemaMigrationsTable() in scripts/lib/migration-ledger.mjs
-- BEFORE any ledger read/write anywhere in the codebase — including before
-- recording this migration's own ledger row. This resolves the chicken-and-
-- egg "the ledger can't record that the ledger-creating migration ran until
-- the ledger exists" problem without a second, competing bootstrap path:
-- there is exactly one bootstrap SQL file, read from disk at runtime, never
-- duplicated as a string literal elsewhere.
--
-- CHECKSUM CONTRACT: migration_id is the exact migration filename (stable,
-- never renumbered). checksum_sha256 is the SHA-256 of the migration file's
-- raw bytes at the moment it was applied. Re-running the SAME migration_id
-- with the SAME checksum is a safe NOOP. The SAME migration_id with a
-- DIFFERENT checksum is a hard error (MIGRATION_CHECKSUM_MISMATCH) — this
-- table is never silently updated to a new checksum; a corrected migration
-- ships as a NEW file with a NEW migration_id instead.
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id     text PRIMARY KEY,
  checksum_sha256  text NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  applied_by       text,
  execution_method text NOT NULL,
  app_commit_sha   text,
  notes            text
);

CREATE INDEX IF NOT EXISTS schema_migrations_applied_at_idx ON schema_migrations (applied_at);
