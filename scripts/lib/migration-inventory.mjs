/**
 * MIGRATION INVENTORY — filesystem discovery + manifest cross-check
 * (Mission B section 11: "make missing migration file/manifest mismatch
 * fail tests").
 *
 * Discovers migrations/*.sql from disk (the actual repo state, never
 * hardcoded) and cross-references it against scripts/migration-manifest.mjs
 * (hand-maintained metadata). Any mismatch in either direction — a file on
 * disk with no manifest entry, or a manifest entry with no matching file —
 * is drift that must be surfaced, never silently ignored.
 *
 * The ledger bootstrap migration itself
 * (migrations/2026-09-12-schema-migrations-ledger.sql, see
 * LEDGER_BOOTSTRAP_MIGRATION_ID in migration-ledger.mjs) is a deliberate,
 * explicit exception: it is governance infrastructure read directly from
 * disk by ensureSchemaMigrationsTable(), not a business migration, so it is
 * intentionally absent from the manifest and excluded here rather than
 * reported as drift.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { listManifestFilenames } from "../migration-manifest.mjs";
import { LEDGER_BOOTSTRAP_MIGRATION_ID } from "./migration-ledger.mjs";

function resolveRepoRoot(root) {
  return root ?? process.cwd();
}

/** Sorted list of every *.sql filename actually present under migrations/. */
export function discoverMigrationFiles({ root } = {}) {
  const dir = join(resolveRepoRoot(root), "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Cross-checks disk vs manifest. Returns:
 *  - filesWithoutManifestEntry: on disk, not in the manifest (excludes the
 *    ledger bootstrap file, which is governance infra by design).
 *  - manifestEntriesWithoutFile: in the manifest, but no matching file on
 *    disk (a manifest entry describing a file that was deleted/renamed).
 * Both arrays are drift signals — an empty array in both means the manifest
 * and the filesystem fully agree.
 */
export function checkInventoryDrift({ root } = {}) {
  const onDisk = new Set(discoverMigrationFiles({ root }));
  const inManifest = new Set(listManifestFilenames());

  const filesWithoutManifestEntry = [...onDisk]
    .filter((f) => f !== LEDGER_BOOTSTRAP_MIGRATION_ID)
    .filter((f) => !inManifest.has(f))
    .sort();

  const manifestEntriesWithoutFile = [...inManifest].filter((f) => !onDisk.has(f)).sort();

  return { filesWithoutManifestEntry, manifestEntriesWithoutFile };
}
