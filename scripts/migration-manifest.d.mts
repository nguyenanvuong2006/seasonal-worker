/**
 * Type declarations for migration-manifest.mjs — hand-written, not generated.
 * Same rationale as scripts/lib/migration-ledger.d.mts: allowJs is false
 * repo-wide, so a co-located .d.mts is the supported way to type a .mjs
 * sibling under "moduleResolution": "bundler".
 */

export type MigrationCategory =
  | "SCHEMA_ADDITIVE"
  | "SCHEMA_DESTRUCTIVE"
  | "DATA_SEED"
  | "DATA_UPDATE_ONLY"
  | "DATA_BACKFILL"
  | "TOMBSTONE_NOOP";

export type AppDependency = "REQUIRED" | "OPTIONAL" | "NONE";

export type ExecutionMechanism =
  | "MANUAL_PSQL_GENERIC"
  | "DOCUMENT_MERGE_SCOPED_RUNNER"
  | "AI_ACTION_PROPOSALS_SCOPED_RUNNER"
  | "AI_COPILOT_CONVERSATIONS_SCOPED_RUNNER"
  | "ELECTRONIC_CONFIRMATION_SCOPED_RUNNER"
  | "RECRUITMENT_SNAPSHOT_SCOPED_RUNNER"
  | "WORKFORCE_LIFECYCLE_SCOPED_RUNNER"
  | "EXCLUDED_FROM_ALL_RUNNERS";

export interface MigrationManifestEntry {
  filename: string;
  category: MigrationCategory;
  objectsCreatedOrModified: string[];
  idempotent: boolean;
  transactionSafe: boolean;
  appDependency: AppDependency;
  appDependencyEvidence: string;
  executionMechanism: ExecutionMechanism;
  supersededBy: string | null;
  tombstoned: boolean;
  tombstonedReason: string | null;
  requiresBackup: boolean;
  productionAllowed: boolean;
  notes: string;
}

export const MIGRATION_MANIFEST: MigrationManifestEntry[];

export function getManifestEntry(filename: string): MigrationManifestEntry | null;

export function listManifestFilenames(): string[];

export function isExecutable(filename: string): boolean;
