/**
 * CANONICAL SINGLE-MIGRATION RUNNER — validation (Mission B section 14).
 * ------------------------------------------------------------
 * Pure, DB-free validation that a requested migration_id is safe to execute
 * through the canonical runner (scripts/run-migration.mjs):
 *   - must be a bare filename (no path separators, no "..", no absolute path)
 *   - must exist in scripts/migration-manifest.mjs (never run an unaudited file)
 *   - must NOT be tombstoned
 *   - must NOT be superseded
 *   - must have productionAllowed = true in the manifest
 *   - must have transactionSafe = true (section 8: this repo has zero
 *     non-transactional migrations today, so the canonical runner simply
 *     refuses anything the manifest doesn't mark transaction-safe rather
 *     than inventing special-case handling for a scenario that doesn't
 *     exist yet — "do not invent complexity if none exist")
 *   - the file must actually exist on disk
 *
 * Separated from scripts/run-migration.mjs (the DB-touching CLI) so this
 * logic — the actual security boundary — is unit-testable without a
 * database connection.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { getManifestEntry } from "../migration-manifest.mjs";

export const MIGRATION_UNKNOWN = "MIGRATION_UNKNOWN";
export const MIGRATION_PATH_INVALID = "MIGRATION_PATH_INVALID";
export const MIGRATION_NOT_EXECUTABLE = "MIGRATION_NOT_EXECUTABLE";

export class MigrationValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MigrationValidationError";
    this.code = code;
  }
}

function resolveRepoRoot(root) {
  return root ?? process.cwd();
}

/**
 * Throws MigrationValidationError for any unsafe/unknown/non-executable
 * migration_id. Returns { entry, filePath } on success.
 */
export function validateMigrationForExecution(migrationId, { root } = {}) {
  if (typeof migrationId !== "string" || migrationId.length === 0) {
    throw new MigrationValidationError(MIGRATION_PATH_INVALID, "migration_id trống hoặc không hợp lệ.");
  }
  if (
    migrationId.includes("/") ||
    migrationId.includes("\\") ||
    migrationId.includes("..") ||
    migrationId !== basename(migrationId)
  ) {
    throw new MigrationValidationError(
      MIGRATION_PATH_INVALID,
      `migration_id không hợp lệ — chỉ chấp nhận tên file thuần, không path/traversal: "${migrationId}"`,
    );
  }
  if (!migrationId.endsWith(".sql")) {
    throw new MigrationValidationError(MIGRATION_PATH_INVALID, `migration_id phải kết thúc bằng ".sql": "${migrationId}"`);
  }

  const entry = getManifestEntry(migrationId);
  if (!entry) {
    throw new MigrationValidationError(
      MIGRATION_UNKNOWN,
      `migration_id "${migrationId}" không có trong scripts/migration-manifest.mjs — canonical runner CHỈ chạy migration đã được audit và ghi vào manifest.`,
    );
  }
  if (entry.tombstoned) {
    throw new MigrationValidationError(
      MIGRATION_NOT_EXECUTABLE,
      `Migration "${migrationId}" đã TOMBSTONED: ${entry.tombstonedReason ?? "(không có lý do ghi lại)"}. Không được chạy lại.`,
    );
  }
  if (entry.supersededBy) {
    throw new MigrationValidationError(
      MIGRATION_NOT_EXECUTABLE,
      `Migration "${migrationId}" đã bị SUPERSEDED bởi "${entry.supersededBy}". Không được chạy lại.`,
    );
  }
  if (!entry.productionAllowed) {
    throw new MigrationValidationError(
      MIGRATION_NOT_EXECUTABLE,
      `Migration "${migrationId}" có productionAllowed=false trong manifest. Canonical runner từ chối chạy.`,
    );
  }
  if (!entry.transactionSafe) {
    throw new MigrationValidationError(
      MIGRATION_NOT_EXECUTABLE,
      `Migration "${migrationId}" có transactionSafe=false trong manifest. Canonical runner CHỈ hỗ trợ migration chạy an toàn trong 1 transaction — cần xử lý thủ công (xem docs/PRODUCTION-DEPLOY.md).`,
    );
  }

  const repoRoot = resolveRepoRoot(root);
  const filePath = join(repoRoot, "migrations", migrationId);
  if (!existsSync(filePath)) {
    throw new MigrationValidationError(MIGRATION_UNKNOWN, `File migration không tồn tại trên đĩa: ${filePath}`);
  }

  return { entry, filePath };
}
