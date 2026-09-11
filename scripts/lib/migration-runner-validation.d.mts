/**
 * Type declarations for migration-runner-validation.mjs — hand-written,
 * not generated. Same rationale as migration-ledger.d.mts.
 */
import type { MigrationManifestEntry } from "../migration-manifest.d.mts";

export const MIGRATION_UNKNOWN: "MIGRATION_UNKNOWN";
export const MIGRATION_PATH_INVALID: "MIGRATION_PATH_INVALID";
export const MIGRATION_NOT_EXECUTABLE: "MIGRATION_NOT_EXECUTABLE";

export class MigrationValidationError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export function validateMigrationForExecution(
  migrationId: string,
  opts?: { root?: string },
): { entry: MigrationManifestEntry; filePath: string };
