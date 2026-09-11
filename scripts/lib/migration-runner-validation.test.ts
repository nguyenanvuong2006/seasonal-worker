/**
 * CANONICAL RUNNER VALIDATION — path-safety + manifest-gating tests
 * (Mission B section 14/21: "path safety: no ../, no arbitrary file, only
 * known migration ids").
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateMigrationForExecution, MigrationValidationError, MIGRATION_UNKNOWN, MIGRATION_PATH_INVALID, MIGRATION_NOT_EXECUTABLE } from "./migration-runner-validation.mjs";

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (err: unknown) => err instanceof MigrationValidationError && err.code === code);
}

test("validateMigrationForExecution: rejects path traversal (../)", () => {
  expectCode(() => validateMigrationForExecution("../../etc/passwd"), MIGRATION_PATH_INVALID);
});

test("validateMigrationForExecution: rejects a path containing a directory separator", () => {
  expectCode(() => validateMigrationForExecution("migrations/2026-09-09-ai-action-proposals.sql"), MIGRATION_PATH_INVALID);
  expectCode(() => validateMigrationForExecution("foo\\bar.sql"), MIGRATION_PATH_INVALID);
});

test("validateMigrationForExecution: rejects an absolute path", () => {
  expectCode(() => validateMigrationForExecution("/etc/passwd"), MIGRATION_PATH_INVALID);
});

test("validateMigrationForExecution: rejects a filename not ending in .sql", () => {
  expectCode(() => validateMigrationForExecution("2026-09-09-ai-action-proposals.txt"), MIGRATION_PATH_INVALID);
});

test("validateMigrationForExecution: rejects empty/non-string migration_id", () => {
  expectCode(() => validateMigrationForExecution(""), MIGRATION_PATH_INVALID);
});

test("validateMigrationForExecution: rejects a filename with no manifest entry (arbitrary file, even if it exists on disk)", () => {
  expectCode(() => validateMigrationForExecution("totally-made-up-migration.sql", { root: process.cwd() }), MIGRATION_UNKNOWN);
});

test("validateMigrationForExecution: rejects a TOMBSTONED migration", () => {
  expectCode(
    () => validateMigrationForExecution("2026-08-24-trainee-registration-canonical-cleanup.sql", { root: process.cwd() }),
    MIGRATION_NOT_EXECUTABLE,
  );
});

test("validateMigrationForExecution: rejects a SUPERSEDED migration", () => {
  expectCode(
    () => validateMigrationForExecution("2026-08-14-reactivate-admin-anvuong.sql", { root: process.cwd() }),
    MIGRATION_NOT_EXECUTABLE,
  );
});

test("validateMigrationForExecution: rejects a migration with productionAllowed=false", () => {
  // 2026-08-14-reactivate-anvuong-admin.sql: productionAllowed=false, no supersededBy, not tombstoned
  expectCode(
    () => validateMigrationForExecution("2026-08-14-reactivate-anvuong-admin.sql", { root: process.cwd() }),
    MIGRATION_NOT_EXECUTABLE,
  );
});

test("validateMigrationForExecution: accepts a known-good, productionAllowed, transaction-safe migration and returns its manifest entry + file path", () => {
  const result = validateMigrationForExecution("2026-09-09-ai-action-proposals.sql", { root: process.cwd() });
  assert.equal(result.entry.filename, "2026-09-09-ai-action-proposals.sql");
  assert.ok(result.filePath.endsWith("migrations/2026-09-09-ai-action-proposals.sql"));
});

test("validateMigrationForExecution: rejects a manifest-known filename whose file is missing on disk", () => {
  expectCode(() => validateMigrationForExecution("2026-09-09-ai-action-proposals.sql", { root: "/tmp/nonexistent-repo-root-xyz" }), MIGRATION_UNKNOWN);
});
