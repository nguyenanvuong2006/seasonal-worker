#!/usr/bin/env node
/**
 * BOOTSTRAP schema_migrations LEDGER — PRODUCTION-SAFE, DEDICATED, FIXED FILE ONLY.
 * ------------------------------------------------------------
 * Runs ONLY migrations/2026-09-12-schema-migrations-ledger.sql (one
 * CREATE TABLE IF NOT EXISTS schema_migrations + one CREATE INDEX IF NOT
 * EXISTS) — never any other file, never an operator-supplied migration id.
 * This script exists because scripts/run-migration.mjs (the canonical
 * single-migration runner) deliberately refuses this exact file: the
 * ledger bootstrap migration is intentionally excluded from
 * scripts/migration-manifest.mjs (it is governance infrastructure, not a
 * business migration — see that file's own docblock), so
 * validateMigrationForExecution() always rejects it with MIGRATION_UNKNOWN.
 * This is the dedicated, narrowly-scoped front door for that one exception,
 * mirroring the same pattern already used for the 6 existing scoped
 * migration runners (Document Merge, AI Action Proposals, AI Copilot
 * Conversations, Electronic Confirmation, Recruitment Snapshot, Workforce
 * Lifecycle) — a fixed, hardcoded filename is the safety boundary, not a
 * runtime argument.
 *
 * Invokes the EXACT SAME canonical primitive every other runner uses —
 * runMigration() from scripts/lib/migration-ledger.mjs — so there is no
 * second checksum/ledger-write implementation anywhere in this script.
 *
 * Cách dùng:
 *   export DATABASE_URL=postgresql://...   # PROD_DATABASE_URL — KHÔNG dùng staging!
 *   node scripts/bootstrap-schema-migrations-ledger.mjs
 *
 * An toàn: migration idempotent (CREATE TABLE/INDEX IF NOT EXISTS via the
 * ledger's own checksum-guarded NOOP contract). Script tự chứng minh:
 *   (a) nội dung file khớp đúng contract governance-only (chỉ CREATE
 *       TABLE/INDEX cho schema_migrations, không DROP/DELETE/TRUNCATE/
 *       UPDATE/INSERT/ALTER bảng khác/GRANT/REVOKE) — kiểm tra TRƯỚC khi kết
 *       nối DB,
 *   (b) row count của các bảng nghiệp vụ KHÔNG đổi trước/sau,
 *   (c) bảng/PK/index/ledger row được tạo đúng cấu trúc,
 *   (d) BACKUP_DECISION được ghi log rõ ràng — KHÔNG bao giờ tự nhận đã xác
 *       minh backup.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigration, getLedgerRow, computeChecksum, LEDGER_BOOTSTRAP_MIGRATION_ID } from "./lib/migration-ledger.mjs";
import { checkBootstrapContentAllowed } from "./lib/bootstrap-content-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_FILE = LEDGER_BOOTSTRAP_MIGRATION_ID;
const SQL_FILE_PATH = join(ROOT, "migrations", MIGRATION_FILE);

// Business tables this bootstrap must NEVER touch — row counts must be
// identical before/after.
const BUSINESS_TABLES = [
  "users",
  "recruitment_requests",
  "employment_sessions",
  "worker_profiles",
  "workforce_movements",
  "candidate_documents",
  "merge_jobs",
  "daily_applications",
  "ai_action_proposals",
  "ai_conversations",
];

console.log("⚠️  BACKUP_DECISION=WAIVED_BY_OWNER");
console.log("⚠️  Chủ hệ thống đã CHỦ ĐỘNG CHỌN không tạo backup trước lần chạy này — migration chỉ tạo bảng governance schema_migrations + 1 index, không chạm bảng nghiệp vụ nào. Đây là quyết định của chủ hệ thống, ghi nhận lại, KHÔNG phải hệ thống tự xác minh có backup.");

if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL (PROD_DATABASE_URL). KHÔNG chạy nếu không chắc chắn đây là production!");
  process.exit(1);
}

console.log(`\n=== BƯỚC 0: Kiểm tra nội dung migrations/${MIGRATION_FILE} khớp contract governance-only (TRƯỚC khi kết nối DB) ===`);
const sqlText = readFileSync(SQL_FILE_PATH, "utf8");
const contentCheck = checkBootstrapContentAllowed(sqlText);
if (!contentCheck.ok) {
  console.error(`❌ File ${contentCheck.reason} — DỪNG LẠI, không kết nối DB.`);
  process.exit(1);
}
console.log("✅ Nội dung migration khớp đúng contract governance-only.");

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const host = (() => {
  try {
    return new URL(DATABASE_URL).hostname;
  } catch {
    return "(không parse được host)";
  }
})();
console.log(`✅ Kết nối DB: host=${host}`);

async function tableExists(name) {
  const r = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${name}`]);
  return r.rows[0].reg !== null;
}
async function rowCounts(tables) {
  const counts = {};
  for (const t of tables) {
    if (!(await tableExists(t))) {
      counts[t] = null;
      continue;
    }
    const r = await client.query(`SELECT count(*)::int AS c FROM ${t}`);
    counts[t] = r.rows[0].c;
  }
  return counts;
}

console.log("\n=== BƯỚC 1: Row count các bảng nghiệp vụ TRƯỚC bootstrap ===");
const before = await rowCounts(BUSINESS_TABLES);
for (const [t, c] of Object.entries(before)) console.log(`  ${t}: ${c === null ? "(không tồn tại)" : c}`);

console.log(`\n=== BƯỚC 2: Bootstrap ledger qua runMigration() (canonical primitive dùng chung với mọi runner khác — không duplicate SQL/checksum logic) ===`);
let result;
try {
  result = await runMigration(client, {
    migrationId: MIGRATION_FILE,
    sqlFilePath: SQL_FILE_PATH,
    executionMethod: "GOVERNANCE_BOOTSTRAP",
    appliedBy: process.env.APPLIED_BY ?? process.env.GITHUB_ACTOR ?? null,
    appCommitSha: process.env.APP_COMMIT_SHA ?? process.env.GITHUB_SHA ?? null,
    notes: "Production ledger bootstrap — owner-authorized. BACKUP_DECISION=WAIVED_BY_OWNER.",
  });
  console.log(`  ${result.status === "APPLIED" ? "✅ APPLIED" : "✅ NOOP_ALREADY_APPLIED"} — migration_id=${result.migrationId} checksum=${result.checksum}`);
} catch (error) {
  console.error(`❌ Bootstrap thất bại: ${error.code ? `[${error.code}] ` : ""}${error.message}`);
  await client.end();
  process.exit(1);
}

console.log("\n=== BƯỚC 3: Verify cấu trúc bảng/PK/index/ledger row ===");
const tableFound = await tableExists("schema_migrations");
console.log(`  ${tableFound ? "✅" : "❌"} Bảng schema_migrations tồn tại`);

const EXPECTED_COLUMNS = ["migration_id", "checksum_sha256", "applied_at", "applied_by", "execution_method", "app_commit_sha", "notes"];
const columnCheck = await client.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'schema_migrations'`,
);
const presentColumns = new Set(columnCheck.rows.map((r) => r.column_name));
const missingColumns = EXPECTED_COLUMNS.filter((c) => !presentColumns.has(c));
for (const c of EXPECTED_COLUMNS) console.log(`  ${presentColumns.has(c) ? "✅" : "❌"} column ${c}`);

const pkCheck = await client.query(
  `SELECT a.attname FROM pg_index i
   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
   WHERE i.indrelid = 'public.schema_migrations'::regclass AND i.indisprimary`,
);
const pkColumns = pkCheck.rows.map((r) => r.attname);
const pkOk = pkColumns.length === 1 && pkColumns[0] === "migration_id";
console.log(`  ${pkOk ? "✅" : "❌"} Primary key: [${pkColumns.join(", ")}]`);

const indexCheck = await client.query(
  `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'schema_migrations' AND indexname = 'schema_migrations_applied_at_idx'`,
);
const indexOk = indexCheck.rowCount > 0;
console.log(`  ${indexOk ? "✅" : "❌"} index schema_migrations_applied_at_idx`);

const ledgerRow = await getLedgerRow(client, MIGRATION_FILE);
const expectedChecksum = computeChecksum(readFileSync(SQL_FILE_PATH));
const ledgerRowOk = Boolean(ledgerRow) && ledgerRow.checksum_sha256 === expectedChecksum && Boolean(ledgerRow.applied_at) && Boolean(ledgerRow.execution_method);
console.log(
  `  ${ledgerRowOk ? "✅" : "❌"} ledger row: migration_id=${ledgerRow?.migration_id ?? "(none)"} checksum_match=${ledgerRow?.checksum_sha256 === expectedChecksum} applied_at=${ledgerRow?.applied_at ? "non-null" : "NULL"} execution_method=${ledgerRow?.execution_method ?? "(none)"}`,
);

console.log("\n=== BƯỚC 4: Row count các bảng nghiệp vụ SAU bootstrap, so sánh với TRƯỚC ===");
const after = await rowCounts(BUSINESS_TABLES);
let businessRowsChanged = false;
for (const t of BUSINESS_TABLES) {
  const b = before[t];
  const a = after[t];
  const same = b === a;
  if (!same) businessRowsChanged = true;
  console.log(`  ${same ? "✅" : "❌"} ${t}: trước=${b === null ? "(không tồn tại)" : b} sau=${a === null ? "(không tồn tại)" : a}`);
}

await client.end();

console.log("\n=== KẾT QUẢ ===");
const allOk = tableFound && missingColumns.length === 0 && pkOk && indexOk && ledgerRowOk && !businessRowsChanged;
if (missingColumns.length > 0) console.error(`❌ Thiếu cột: ${missingColumns.join(", ")}`);
if (!pkOk) console.error("❌ Primary key sai hoặc thiếu.");
if (!indexOk) console.error("❌ Thiếu index schema_migrations_applied_at_idx.");
if (!ledgerRowOk) console.error("❌ Ledger row không đúng.");
if (businessRowsChanged) console.error("❌ Row count của một bảng nghiệp vụ đã thay đổi — DỪNG LẠI, điều tra ngay.");
console.log(
  allOk
    ? `✅ PASS — ${result.status}, bảng/PK/index/ledger row đúng cấu trúc, không chạm bảng nghiệp vụ nào.`
    : "❌ FAIL — xem chi tiết ở trên.",
);
process.exit(allOk ? 0 : 1);
