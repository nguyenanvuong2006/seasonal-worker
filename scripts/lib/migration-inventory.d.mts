/**
 * Type declarations for migration-inventory.mjs — hand-written, not
 * generated. Same rationale as migration-ledger.d.mts.
 */

export function discoverMigrationFiles(opts?: { root?: string }): string[];

export interface InventoryDrift {
  filesWithoutManifestEntry: string[];
  manifestEntriesWithoutFile: string[];
}

export function checkInventoryDrift(opts?: { root?: string }): InventoryDrift;
