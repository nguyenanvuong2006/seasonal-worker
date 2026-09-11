/**
 * Type declarations for migration-ledger.mjs — hand-written, not generated.
 * The runtime module stays plain JS (no build step) so it can be `node`'d
 * directly in CI/Production migration scripts; this file exists only so
 * TypeScript test files importing it get real types instead of `any`
 * (allowJs is false repo-wide, so a co-located .d.mts is the supported way
 * to type-check a .mjs sibling under "moduleResolution": "bundler").
 */

export interface PgLikeClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

export const MIGRATION_CHECKSUM_MISMATCH: "MIGRATION_CHECKSUM_MISMATCH";
export const LEDGER_BOOTSTRAP_MIGRATION_ID: string;

export class MigrationLedgerError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export function computeChecksum(buffer: Buffer): string;

export function ensureSchemaMigrationsTable(client: PgLikeClient, opts?: { root?: string }): Promise<void>;

export function schemaMigrationsTableExists(client: PgLikeClient): Promise<boolean>;

export interface LedgerRow {
  migration_id: string;
  checksum_sha256: string;
  applied_at: Date;
  applied_by: string | null;
  execution_method: string;
  app_commit_sha: string | null;
  notes: string | null;
}

export function getLedgerRow(client: PgLikeClient, migrationId: string): Promise<LedgerRow | null>;

export function listLedgerRows(client: PgLikeClient): Promise<LedgerRow[]>;

export type MigrationRecordStatus = "NOOP" | "APPLIED";

export interface MigrationRecordResult {
  status: MigrationRecordStatus;
  migrationId: string;
  checksum: string;
}

export function recordMigration(
  client: PgLikeClient,
  opts: {
    migrationId: string;
    checksum: string;
    appliedBy?: string | null;
    executionMethod: string;
    appCommitSha?: string | null;
    notes?: string | null;
    execute?: ((client: PgLikeClient) => Promise<void>) | null;
  },
): Promise<MigrationRecordResult>;

export function runMigration(
  client: PgLikeClient,
  opts: {
    migrationId: string;
    sqlFilePath: string;
    appliedBy?: string | null;
    executionMethod: string;
    appCommitSha?: string | null;
    notes?: string | null;
  },
): Promise<MigrationRecordResult>;

export function recordAlreadyExecutedMigration(
  client: PgLikeClient,
  opts: {
    migrationId: string;
    sqlFilePath: string;
    appliedBy?: string | null;
    executionMethod: string;
    appCommitSha?: string | null;
    notes?: string | null;
  },
): Promise<MigrationRecordResult>;
