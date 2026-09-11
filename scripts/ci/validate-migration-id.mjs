#!/usr/bin/env node
/**
 * CI guardrail helper for .github/workflows/migrate-single-production.yml.
 * Validates the MIGRATION_ID env var against scripts/migration-manifest.mjs
 * (via scripts/lib/migration-runner-validation.mjs) BEFORE any Production DB
 * connection is attempted. Exits non-zero with a clear message on any
 * unsafe/unknown migration_id (path traversal, unknown filename,
 * tombstoned, superseded, productionAllowed=false, transactionSafe=false).
 */
import { validateMigrationForExecution, MigrationValidationError } from "../lib/migration-runner-validation.mjs";

const migrationId = process.env.MIGRATION_ID;

try {
  const { entry } = validateMigrationForExecution(migrationId, { root: process.cwd() });
  console.log(`✅ migration_id hợp lệ: ${entry.filename} (category=${entry.category}, appDependency=${entry.appDependency})`);
} catch (err) {
  if (err instanceof MigrationValidationError) {
    console.error(`❌ [${err.code}] ${err.message}`);
    process.exit(1);
  }
  throw err;
}
