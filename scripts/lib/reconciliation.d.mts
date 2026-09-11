/**
 * Type declarations for reconciliation.mjs — hand-written, not generated.
 * Same rationale as migration-ledger.d.mts.
 */
import type { PgLikeClient, LedgerRow } from "./migration-ledger.d.mts";
import type { MigrationManifestEntry } from "../migration-manifest.d.mts";
import type { InventoryDrift } from "./migration-inventory.d.mts";

export type StructuralExpect = "present" | "absent" | "informational";

export interface ParsedObjectRef {
  kind: string;
  identifier: string;
  expect: StructuralExpect;
  label: string;
}

export function parseObjectRef(raw: string): ParsedObjectRef | null;

export interface StructuralCheck {
  label: string;
  kind: string;
  expect: StructuralExpect;
  exists: boolean;
  ok: boolean;
}

export interface StructuralEvidence {
  checks: StructuralCheck[];
  requiredTotal: number;
  requiredSatisfied: number;
}

export function computeStructuralEvidence(client: PgLikeClient, objectsCreatedOrModified: string[]): Promise<StructuralEvidence>;

export type MigrationClassification =
  | "APPLIED_CONFIRMED"
  | "LEDGER_CHECKSUM_MISMATCH"
  | "TOMBSTONED"
  | "SUPERSEDED"
  | "SCHEMA_PRESENT_UNLEDGERED"
  | "NOT_APPLIED_CONFIRMED"
  | "UNKNOWN"
  | "FILE_MISSING_ON_DISK";

export type MigrationRisk = "NONE" | "CRITICAL_APP_DEPENDENCY" | "ACTIVE_FEATURE_DEPENDENCY" | "LEGACY";

export function classifyMigration(opts: {
  manifestEntry: MigrationManifestEntry;
  currentChecksum: string;
  ledgerRow: LedgerRow | null;
  structuralEvidence: StructuralEvidence;
}): { classification: MigrationClassification; risk: MigrationRisk };

export type LedgerStatus = "LEDGER_NOT_BOOTSTRAPPED" | "NO_LEDGER_ROW" | "LEDGER_ROW_PRESENT";

export interface ReconciliationRow {
  filename: string;
  ledgerStatus: LedgerStatus;
  classification: MigrationClassification;
  risk: MigrationRisk;
  structuralEvidence: StructuralEvidence | null;
  notes: string;
}

export interface ReconciliationReport {
  ledgerBootstrapped: boolean;
  drift: InventoryDrift;
  rows: ReconciliationRow[];
}

export function reconcileMigrations(client: PgLikeClient, opts?: { root?: string }): Promise<ReconciliationReport>;
