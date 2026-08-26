/**
 * ASSIGNMENT ACTOR — migration safety (no Production DB write during dev).
 *
 * The two additive migrations must be idempotent and non-destructive:
 *   - columns added via `ADD COLUMN IF NOT EXISTS` only,
 *   - mapping semantics changed via a single scoped UPDATE (never a DROP /
 *     DELETE / TRUNCATE / unconditional UPDATE),
 *   - published snapshots (merge_template_versions.mapping_snapshot) untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readMigration(name: string): string {
  return readFileSync(join(REPO_ROOT, "migrations", name), "utf8");
}

// Strip `--` comment lines so prose in the migration header ("KHÔNG DROP/DELETE…")
// is not mistaken for a real destructive statement.
function sqlBody(name: string): string {
  return readMigration(name)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const DESTRUCTIVE = /\b(DROP|DELETE|TRUNCATE|ALTER TABLE\s+\S+\s+DROP)\b/i;

test("assignment-actor freeze migration is additive (ADD COLUMN IF NOT EXISTS only)", () => {
  const sql = sqlBody("2026-08-26-assignment-actor-freeze.sql");
  assert.doesNotMatch(sql, DESTRUCTIVE);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS assigned_by/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS assigned_by_display_name/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS assigned_at/);
});

test("Nguoi_tiep_nhan mapping migration is a scoped UPDATE and never touches published snapshots", () => {
  const sql = sqlBody("2026-08-26-nguoi-tiep-nhan-assigned-by-display-name.sql");
  assert.doesNotMatch(sql, DESTRUCTIVE);
  assert.match(sql, /UPDATE merge_template_fields/);
  assert.match(sql, /SET source_field = 'ASSIGNED_BY_DISPLAY_NAME'/);
  assert.match(sql, /WHERE[\s\S]*placeholder = 'Nguoi_tiep_nhan'/);
  assert.doesNotMatch(sql, /merge_template_versions/, "must not touch version snapshots");
  assert.doesNotMatch(sql, /mapping_snapshot/, "must not touch published snapshots");
});
