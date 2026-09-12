/**
 * BOOTSTRAP CONTENT GUARD — pure, DB-free check that
 * migrations/2026-09-12-schema-migrations-ledger.sql's content still
 * matches the governance-only contract (belt-and-suspenders, not the
 * primary safety boundary — scripts/bootstrap-schema-migrations-ledger.mjs
 * takes NO migration id/path argument, so its fixed, hardcoded filename IS
 * the primary boundary; this guards against that one file's CONTENT
 * silently becoming destructive between review and execution).
 *
 * Separated into its own pure module so it's unit-testable without a
 * database connection, mirroring scripts/lib/migration-runner-validation.mjs's
 * separation of validation logic from the DB-touching CLI.
 */

const FORBIDDEN_SQL_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bUPDATE\s+\w+\s+SET\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bALTER\s+TABLE\s+(?!schema_migrations\b)/i,
  /\bDROP\s+INDEX\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
];

const REQUIRED_SQL_PATTERNS = [/CREATE TABLE IF NOT EXISTS schema_migrations\b/i, /CREATE INDEX IF NOT EXISTS schema_migrations_applied_at_idx\b/i];

/**
 * Returns { ok: true } if sqlText matches the governance-only bootstrap
 * contract, or { ok: false, reason: string } naming the first violation
 * found (a matched forbidden pattern, or a missing required one).
 */
export function checkBootstrapContentAllowed(sqlText) {
  for (const pattern of FORBIDDEN_SQL_PATTERNS) {
    if (pattern.test(sqlText)) {
      return { ok: false, reason: `chứa pattern KHÔNG được phép cho bootstrap (${pattern})` };
    }
  }
  for (const pattern of REQUIRED_SQL_PATTERNS) {
    if (!pattern.test(sqlText)) {
      return { ok: false, reason: `KHÔNG khớp cấu trúc bootstrap kỳ vọng (thiếu: ${pattern})` };
    }
  }
  return { ok: true, reason: null };
}
