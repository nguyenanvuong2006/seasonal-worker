#!/usr/bin/env node
/**
 * CANONICAL SINGLE-MIGRATION RUNNER (Mission B section 14).
 * ------------------------------------------------------------
 * Runs exactly ONE migration, selected by filename, through the shared
 * ledger contract (scripts/lib/migration-ledger.mjs runMigration()):
 * BEGIN → ensure ledger table → advisory lock → checksum-guarded
 * NOOP/APPLIED/hard-error → COMMIT. Validated first against
 * scripts/migration-manifest.mjs (scripts/lib/migration-runner-validation.mjs):
 * refuses unknown filenames, path traversal, tombstoned, superseded,
 * productionAllowed=false, and non-transactionSafe entries.
 *
 * This is the PREFERRED path for any NEW migration going forward. It does
 * NOT replace the 6 existing scoped runners (Document Merge, AI Action
 * Proposals, AI Copilot Conversations, Electronic Confirmation, Recruitment
 * Snapshot, Workforce Lifecycle) — those have hard-won, incident-driven
 * verification logic specific to their migrations and record into the same
 * ledger via recordAlreadyExecutedMigration() after their own verification
 * passes (see docs/PRODUCTION-DEPLOY.md).
 *
 * Usage:
 *   DATABASE_URL=postgres://... MIGRATION_ID=2026-xx-yy-name.sql node scripts/run-migration.mjs
 *   node scripts/run-migration.mjs 2026-xx-yy-name.sql   # positional arg also accepted
 *
 * Optional env: APPLIED_BY, APP_COMMIT_SHA, MIGRATION_NOTES.
 *
 * Backup: this script does NOT verify a backup was taken — it can only
 * ever log what it was TOLD. Set BACKUP_DECISION=CONFIRMED_BY_OPERATOR or
 * BACKUP_DECISION=WAIVED_BY_OWNER (see Mission B section 15 — never claim
 * "backup verified" from a checkbox input).
 */
import { config } from "dotenv";
import pg from "pg";
import { validateMigrationForExecution, MigrationValidationError } from "./lib/migration-runner-validation.mjs";
import { runMigration } from "./lib/migration-ledger.mjs";

config({ path: ".env.local" });
config();

const migrationId = process.env.MIGRATION_ID ?? process.argv[2];
const backupDecision = process.env.BACKUP_DECISION ?? "NOT_RECORDED";

console.log(`ℹ️  BACKUP_DECISION=${backupDecision}`);
if (backupDecision === "NOT_RECORDED") {
  console.log("⚠️  Không có BACKUP_DECISION được truyền vào — script này KHÔNG tự xác nhận đã có backup.");
}

if (!migrationId) {
  console.error("❌ Thiếu migration_id. Dùng: MIGRATION_ID=<filename>.sql node scripts/run-migration.mjs (hoặc truyền positional arg).");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("❌ Thiếu DATABASE_URL.");
  process.exit(1);
}

let validated;
try {
  validated = validateMigrationForExecution(migrationId, { root: process.cwd() });
} catch (err) {
  if (err instanceof MigrationValidationError) {
    console.error(`❌ [${err.code}] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

console.log(`✅ Migration hợp lệ: ${migrationId} (category=${validated.entry.category}, appDependency=${validated.entry.appDependency})`);

const client = new pg.Client({ connectionString: url });

async function main() {
  await client.connect();
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "(không parse được host)";
    }
  })();
  console.log(`✅ Kết nối DB: host=${host}`);

  try {
    const result = await runMigration(client, {
      migrationId,
      sqlFilePath: validated.filePath,
      appliedBy: process.env.APPLIED_BY ?? null,
      executionMethod: "CANONICAL_SINGLE_RUNNER",
      appCommitSha: process.env.APP_COMMIT_SHA ?? null,
      notes: process.env.MIGRATION_NOTES ?? null,
    });
    console.log(`\n✅ ${result.status} — migration_id=${result.migrationId} checksum=${result.checksum}`);
    if (result.status === "NOOP") {
      console.log("ℹ️  Migration đã có trong ledger với checksum khớp — không chạy lại SQL.");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`❌ ${err.code ? `[${err.code}] ` : ""}${err.message}`);
  process.exit(1);
});
