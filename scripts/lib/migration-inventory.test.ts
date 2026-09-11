/**
 * MIGRATION INVENTORY — tests proving the manifest and the actual
 * migrations/*.sql directory on disk agree, per Mission B section 11
 * ("make missing migration file/manifest mismatch fail tests").
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMigrationFiles, checkInventoryDrift } from "./migration-inventory.mjs";
import { listManifestFilenames } from "../migration-manifest.mjs";
import { LEDGER_BOOTSTRAP_MIGRATION_ID } from "./migration-ledger.mjs";

test("discoverMigrationFiles: finds every *.sql file under migrations/ in the real repo", () => {
  const files = discoverMigrationFiles({ root: process.cwd() });
  assert.ok(files.length > 0, "expected at least one migration file");
  assert.ok(files.includes(LEDGER_BOOTSTRAP_MIGRATION_ID), "the ledger bootstrap migration must be discoverable on disk");
  assert.deepEqual(files, [...files].sort(), "must be returned in stable sorted order");
});

test("checkInventoryDrift: the real repo has ZERO drift between migrations/*.sql and scripts/migration-manifest.mjs", () => {
  const drift = checkInventoryDrift({ root: process.cwd() });
  assert.deepEqual(
    drift.filesWithoutManifestEntry,
    [],
    "every migrations/*.sql file (other than the ledger bootstrap migration, which is intentionally excluded) must have a manifest entry",
  );
  assert.deepEqual(
    drift.manifestEntriesWithoutFile,
    [],
    "every manifest entry must correspond to a real file on disk — a manifest entry with no file describes a migration that no longer exists",
  );
});

test("checkInventoryDrift: the ledger bootstrap migration is deliberately excluded, never reported as drift", () => {
  const drift = checkInventoryDrift({ root: process.cwd() });
  assert.ok(
    !drift.filesWithoutManifestEntry.includes(LEDGER_BOOTSTRAP_MIGRATION_ID),
    "the ledger bootstrap file is governance infra, not a business migration — must not be flagged as missing-manifest-entry drift",
  );
});

test("checkInventoryDrift: a manifest filename list is consistent with listManifestFilenames() (no duplicate/typo'd entries)", () => {
  const names = listManifestFilenames();
  assert.equal(new Set(names).size, names.length, "manifest must not contain duplicate filenames");
});

function makeTempRepo() {
  const root = mkdtempSync(join(tmpdir(), "migration-inventory-test-"));
  mkdirSync(join(root, "migrations"));
  return root;
}

test("checkInventoryDrift: a file on disk with NO manifest entry is reported as filesWithoutManifestEntry (fails loudly, never silently ignored)", () => {
  const root = makeTempRepo();
  try {
    writeFileSync(join(root, "migrations", "2099-01-01-totally-unmanifested.sql"), "SELECT 1;", "utf8");
    const drift = checkInventoryDrift({ root });
    assert.deepEqual(drift.filesWithoutManifestEntry, ["2099-01-01-totally-unmanifested.sql"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkInventoryDrift: a manifest entry whose file was deleted is reported as manifestEntriesWithoutFile", () => {
  const root = makeTempRepo();
  try {
    // Empty migrations/ dir — every real manifest entry is now "missing its file".
    const drift = checkInventoryDrift({ root });
    const realManifestNames = listManifestFilenames();
    for (const name of realManifestNames) {
      assert.ok(drift.manifestEntriesWithoutFile.includes(name), `expected ${name} to be reported as missing when migrations/ is empty`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
