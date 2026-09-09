#!/usr/bin/env node
/**
 * RUN ai_action_proposals MIGRATION — PRODUCTION-SAFE, SCOPED.
 *
 * Runs ONLY migrations/2026-09-09-ai-action-proposals.sql (one new,
 * additive-only CREATE TABLE IF NOT EXISTS + 3 CREATE INDEX IF NOT EXISTS
 * statements) — never the general migrations/*.sql sweep, never any other
 * pending migration. Mirrors scripts/run-recruitment-snapshot-columns-migration.mjs's
 * exact shape (same repo, same governance).
 *
 * Cách dùng:
 *   export DATABASE_URL=postgresql://...   # PROD_DATABASE_URL — KHÔNG dùng staging!
 *   node scripts/run-ai-action-proposals-migration.mjs
 *
 * An toàn: migration idempotent (CREATE TABLE/INDEX IF NOT EXISTS). Không
 * DROP/TRUNCATE/DELETE/ALTER bảng hiện có. Không sửa dữ liệu nghiệp vụ hiện có.
 * Script này còn tự kiểm tra: (a) row count của các bảng nghiệp vụ chính
 * KHÔNG đổi trước/sau, (b) chạy lại migration lần 2 để chứng minh idempotent.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_FILE = "2026-09-09-ai-action-proposals.sql";

const EXPECTED_COLUMNS = [
  "id",
  "action",
  "status",
  "payload",
  "human_readable_preview",
  "department_id",
  "required_permission",
  "data_scope_snapshot",
  "idempotency_key",
  "created_by",
  "expires_at",
  "confirmed_by",
  "confirmed_at",
  "executed_at",
  "execution_result",
  "error_message",
  "created_at",
  "updated_at",
];

// Bảng nghiệp vụ chính — migration này KHÔNG được chạm vào, kiểm tra row count trước/sau.
const BUSINESS_TABLES = [
  "recruitment_requests",
  "employment_sessions",
  "worker_profiles",
  "workforce_movements",
  "candidate_documents",
  "merge_jobs",
  "daily_applications",
];

if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL (PROD_DATABASE_URL). KHÔNG chạy nếu không chắc chắn đây là production!");
  process.exit(1);
}

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
      counts[t] = null; // bảng không tồn tại ở DB này — bỏ qua, không phải lỗi của migration này.
      continue;
    }
    const r = await client.query(`SELECT count(*)::int AS c FROM ${t}`);
    counts[t] = r.rows[0].c;
  }
  return counts;
}

console.log("\n=== BƯỚC 1: Chụp row count các bảng nghiệp vụ TRƯỚC migration ===");
const before = await rowCounts(BUSINESS_TABLES);
for (const [t, c] of Object.entries(before)) console.log(`  ${t}: ${c === null ? "(không tồn tại)" : c}`);

const sql = readFileSync(join(ROOT, "migrations", MIGRATION_FILE), "utf8");

console.log(`\n=== BƯỚC 2: Chạy migrations/${MIGRATION_FILE} (lần 1) ===`);
try {
  await client.query(sql);
  console.log(`✅ migrations/${MIGRATION_FILE} (lần 1) — OK`);
} catch (error) {
  console.error(`❌ migrations/${MIGRATION_FILE}: ${error.message.slice(0, 500)}`);
  await client.end();
  process.exit(1);
}

console.log(`\n=== BƯỚC 3: Chạy lại migrations/${MIGRATION_FILE} (lần 2) — chứng minh idempotent ===`);
try {
  await client.query(sql);
  console.log(`✅ migrations/${MIGRATION_FILE} (lần 2) — OK, không lỗi khi chạy lại (idempotent)`);
} catch (error) {
  console.error(`❌ Migration KHÔNG idempotent — lần 2 lỗi: ${error.message.slice(0, 500)}`);
  await client.end();
  process.exit(1);
}

console.log("\n=== BƯỚC 4: Kiểm tra cấu trúc bảng ai_action_proposals ===");
const tableFound = await tableExists("ai_action_proposals");
console.log(`  ${tableFound ? "✅" : "❌"} Bảng ai_action_proposals tồn tại`);
if (!tableFound) {
  await client.end();
  process.exit(1);
}

const columnCheck = await client.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_action_proposals'`,
);
const presentColumns = new Set(columnCheck.rows.map((r) => r.column_name));
const missingColumns = EXPECTED_COLUMNS.filter((c) => !presentColumns.has(c));
console.log("\n  Cột kỳ vọng:");
for (const c of EXPECTED_COLUMNS) console.log(`    ${presentColumns.has(c) ? "✅" : "❌"} ${c}`);

const pkCheck = await client.query(
  `SELECT a.attname FROM pg_index i
   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
   WHERE i.indrelid = 'public.ai_action_proposals'::regclass AND i.indisprimary`,
);
const pkColumns = pkCheck.rows.map((r) => r.attname);
console.log(`\n  ${pkColumns.length === 1 && pkColumns[0] === "id" ? "✅" : "❌"} Primary key: [${pkColumns.join(", ")}]`);

const constraintCheck = await client.query(
  `SELECT conname FROM pg_constraint WHERE conrelid = 'public.ai_action_proposals'::regclass AND contype = 'c'`,
);
const constraintNames = constraintCheck.rows.map((r) => r.conname);
const hasStatusCheck = constraintNames.includes("ai_action_proposal_status_chk");
console.log(`  ${hasStatusCheck ? "✅" : "❌"} CHECK constraint ai_action_proposal_status_chk`);

const indexCheck = await client.query(
  `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ai_action_proposals'`,
);
const indexNames = new Set(indexCheck.rows.map((r) => r.indexname));
const EXPECTED_INDEXES = ["ai_action_proposal_idempotency_uq", "ai_action_proposal_created_by_idx", "ai_action_proposal_status_idx"];
console.log("\n  Index kỳ vọng:");
for (const idx of EXPECTED_INDEXES) console.log(`    ${indexNames.has(idx) ? "✅" : "❌"} ${idx}`);
const missingIndexes = EXPECTED_INDEXES.filter((i) => !indexNames.has(i));

console.log("\n=== BƯỚC 5: Chụp row count các bảng nghiệp vụ SAU migration, so sánh ===");
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
const allOk = missingColumns.length === 0 && pkColumns.length === 1 && pkColumns[0] === "id" && hasStatusCheck && missingIndexes.length === 0 && !businessRowsChanged;
if (missingColumns.length > 0) console.error(`❌ Thiếu cột: ${missingColumns.join(", ")}`);
if (missingIndexes.length > 0) console.error(`❌ Thiếu index: ${missingIndexes.join(", ")}`);
if (businessRowsChanged) console.error("❌ Row count của một bảng nghiệp vụ đã thay đổi — DỪNG LẠI, điều tra ngay.");
console.log(allOk ? "✅ PASS — bảng ai_action_proposals đã tạo đúng cấu trúc, idempotent, không chạm dữ liệu nghiệp vụ." : "❌ FAIL — xem chi tiết ở trên.");
process.exit(allOk ? 0 : 1);
