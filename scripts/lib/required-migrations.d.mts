/**
 * Type declarations for required-migrations.mjs — hand-written, not
 * generated. Same rationale as migration-ledger.d.mts.
 */
import type { PgLikeClient } from "./migration-ledger.d.mts";

export interface ProbeCheck {
  label: string;
  ok: boolean;
}

export interface RequiredMigration {
  migrationId: string;
  description: string;
  probe: (client: PgLikeClient) => Promise<ProbeCheck[]>;
}

export const REQUIRED_MIGRATIONS: RequiredMigration[];

export interface RequiredMigrationEvidence {
  migrationId: string;
  description: string;
  checks: ProbeCheck[];
  allPresent: boolean;
}

export function checkRequiredMigrationEvidence(client: PgLikeClient): Promise<RequiredMigrationEvidence[]>;
