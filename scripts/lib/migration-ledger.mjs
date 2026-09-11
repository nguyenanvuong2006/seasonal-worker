/**
 * SCHEMA MIGRATIONS LEDGER — shared runtime helper.
 * ------------------------------------------------------------
 * Single source of truth for how ANY migration runner (the new canonical
 * scripts/run-migration.mjs, or the existing scoped runners recording after
 * their own execution+verification) writes to the `schema_migrations`
 * ledger. Every code path funnels through recordMigration() so the
 * checksum-guard / advisory-lock / no-partial-row contract is enforced
 * exactly once, never reimplemented per-runner.
 *
 * Bootstrap: ensureSchemaMigrationsTable() executes
 * migrations/2026-09-12-schema-migrations-ledger.sql directly from disk
 * (read at call time, never duplicated as a string literal here) — see that
 * file's own docblock for the full bootstrap contract. Called at the start
 * of every ledger operation, so the table's existence never depends on a
 * separate, earlier bootstrap step having already run.
 *
 * Concurrency: a Postgres session-transaction advisory lock keyed by
 * hashtext(migration_id) (pg_advisory_xact_lock — auto-released at
 * COMMIT/ROLLBACK) serializes two concurrent attempts to record/execute the
 * SAME migration_id. The table's PRIMARY KEY on migration_id is a second,
 * independent backstop: even if the advisory lock were somehow bypassed,
 * two concurrent INSERTs for the same id can never both succeed — the
 * loser's whole transaction (migration SQL included, since both run inside
 * one BEGIN/COMMIT) rolls back.
 *
 * This module does raw SQL only — no ORM, no schema import, no
 * "server-only" — so it can be used by both Node CLI scripts (scoped
 * migration runners, the CI workflow runner) and by node:test directly with
 * a hand-rolled fake `client` (anything exposing `.query(text, params)`).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATION_CHECKSUM_MISMATCH = "MIGRATION_CHECKSUM_MISMATCH";

export class MigrationLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MigrationLedgerError";
    this.code = code;
  }
}

/** SHA-256 hex digest of raw file bytes — never of a decoded/normalized string, so line-ending or encoding drift between environments can never silently change the checksum. */
export function computeChecksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export const LEDGER_BOOTSTRAP_MIGRATION_ID = "2026-09-12-schema-migrations-ledger.sql";

function resolveRepoRoot(root) {
  return root ?? process.cwd();
}

/** Idempotent: CREATE TABLE/INDEX IF NOT EXISTS only. Safe to call before every ledger operation, including this migration's own future recording. */
export async function ensureSchemaMigrationsTable(client, { root } = {}) {
  const path = join(resolveRepoRoot(root), "migrations", LEDGER_BOOTSTRAP_MIGRATION_ID);
  const sql = readFileSync(path, "utf8");
  await client.query(sql);
}

export async function schemaMigrationsTableExists(client) {
  const r = await client.query("SELECT to_regclass('public.schema_migrations') AS reg");
  return r.rows[0].reg !== null;
}

export async function getLedgerRow(client, migrationId) {
  const r = await client.query(
    "SELECT migration_id, checksum_sha256, applied_at, applied_by, execution_method, app_commit_sha, notes FROM schema_migrations WHERE migration_id = $1",
    [migrationId],
  );
  return r.rows[0] ?? null;
}

export async function listLedgerRows(client) {
  const r = await client.query(
    "SELECT migration_id, checksum_sha256, applied_at, applied_by, execution_method, app_commit_sha, notes FROM schema_migrations ORDER BY applied_at",
  );
  return r.rows;
}

/**
 * Core ledger-write contract, shared by runMigration() (executes the SQL
 * itself) and recordAlreadyExecutedMigration() (the migration's SQL was
 * already run — and already verified — by the caller's own logic; this
 * only records it). `execute`, when given, runs INSIDE the same
 * transaction as the ledger INSERT, so a failing migration never leaves a
 * ledger row behind (Postgres DDL/DML is transactional; ROLLBACK undoes
 * both).
 *
 * Returns { status: "NOOP" | "APPLIED", migrationId, checksum }.
 * Throws MigrationLedgerError(MIGRATION_CHECKSUM_MISMATCH) if a ledger row
 * already exists for this migration_id with a DIFFERENT checksum — never
 * silently overwritten.
 */
export async function recordMigration(client, { migrationId, checksum, appliedBy = null, executionMethod, appCommitSha = null, notes = null, execute = null }) {
  if (!migrationId) throw new Error("recordMigration: thiếu migrationId");
  if (!checksum) throw new Error("recordMigration: thiếu checksum");
  if (!executionMethod) throw new Error("recordMigration: thiếu executionMethod");

  await ensureSchemaMigrationsTable(client);

  await client.query("BEGIN");
  try {
    // Advisory lock giữ trong suốt transaction — 2 lệnh gọi đồng thời cùng
    // migrationId sẽ chạy TUẦN TỰ (không đồng thời), auto-release khi
    // COMMIT/ROLLBACK. Khoá theo hashtext(migration_id) — không cần bảng
    // lock riêng, không cần external lock service.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [migrationId]);

    const existing = await client.query(
      "SELECT checksum_sha256 FROM schema_migrations WHERE migration_id = $1 FOR UPDATE",
      [migrationId],
    );
    if (existing.rowCount > 0) {
      const existingChecksum = existing.rows[0].checksum_sha256;
      await client.query("ROLLBACK");
      if (existingChecksum === checksum) {
        return { status: "NOOP", migrationId, checksum };
      }
      throw new MigrationLedgerError(
        MIGRATION_CHECKSUM_MISMATCH,
        `Migration "${migrationId}" đã có trong ledger với checksum KHÁC (ledger=${existingChecksum} file=${checksum}). ` +
          "File migration đã bị sửa SAU KHI apply, hoặc migration_id bị dùng trùng cho 2 nội dung khác nhau. " +
          "KHÔNG tự động ghi đè checksum — migration lịch sử là bất biến; nếu cần sửa, tạo migration MỚI với id mới.",
      );
    }

    if (execute) await execute(client);

    await client.query(
      `INSERT INTO schema_migrations (migration_id, checksum_sha256, applied_by, execution_method, app_commit_sha, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [migrationId, checksum, appliedBy, executionMethod, appCommitSha, notes],
    );
    await client.query("COMMIT");
    return { status: "APPLIED", migrationId, checksum };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK trên transaction đã tự abort (vd sau lỗi SQL) — bỏ qua, lỗi gốc mới quan trọng.
    }
    throw error;
  }
}

/**
 * Canonical path for NEW migrations (scripts/run-migration.mjs): reads the
 * migration file, computes its checksum, executes it, and records it — all
 * inside one transaction. Never leaves a ledger row for a migration whose
 * SQL failed.
 */
export async function runMigration(client, { migrationId, sqlFilePath, appliedBy = null, executionMethod, appCommitSha = null, notes = null }) {
  const buffer = readFileSync(sqlFilePath);
  const checksum = computeChecksum(buffer);
  const sqlText = buffer.toString("utf8");
  return recordMigration(client, {
    migrationId,
    checksum,
    appliedBy,
    executionMethod,
    appCommitSha,
    notes,
    execute: (c) => c.query(sqlText),
  });
}

/**
 * Integration point for the EXISTING scoped migration runners (Document
 * Merge, AI Action Proposals, AI Copilot Conversations, Electronic
 * Confirmation, Recruitment Snapshot, Workforce Lifecycle): call this AFTER
 * that script's own migration execution + its own extensive verification
 * has already passed. Does NOT re-run the migration SQL — only records it,
 * through the exact same checksum/lock/mismatch contract runMigration()
 * uses. Lets every mechanism feed the same ledger without touching any
 * scoped runner's hard-won, incident-driven verification logic.
 */
export async function recordAlreadyExecutedMigration(client, { migrationId, sqlFilePath, appliedBy = null, executionMethod, appCommitSha = null, notes = null }) {
  const buffer = readFileSync(sqlFilePath);
  const checksum = computeChecksum(buffer);
  return recordMigration(client, { migrationId, checksum, appliedBy, executionMethod, appCommitSha, notes, execute: null });
}
