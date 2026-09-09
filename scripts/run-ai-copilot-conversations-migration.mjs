#!/usr/bin/env node
/**
 * RUN ai_conversations / ai_conversation_messages MIGRATION — PRODUCTION-SAFE, SCOPED.
 *
 * Runs ONLY migrations/2026-09-10-ai-copilot-conversations.sql (two new
 * CREATE TABLE IF NOT EXISTS + indexes + guarded FK ADD CONSTRAINT blocks)
 * — never the general migrations/*.sql sweep, never any other pending
 * migration. Mirrors scripts/run-ai-action-proposals-migration.mjs's exact
 * shape (same repo, same governance).
 *
 * Cách dùng:
 *   export DATABASE_URL=postgresql://...   # PROD_DATABASE_URL — KHÔNG dùng staging!
 *   node scripts/run-ai-copilot-conversations-migration.mjs
 *
 * An toàn: migration idempotent (CREATE TABLE/INDEX IF NOT EXISTS, FK ADD
 * CONSTRAINT tự guard bằng pg_constraint lookup). Không DROP/TRUNCATE/
 * DELETE/ALTER bảng hiện có (kể cả users — chỉ THÊM một FK tham chiếu tới
 * users.id, không sửa dữ liệu users). Script này còn tự kiểm tra: (a) row
 * count của các bảng nghiệp vụ chính (bao gồm users) KHÔNG đổi trước/sau,
 * (b) chạy lại migration lần 2 để chứng minh idempotent.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_FILE = "2026-09-10-ai-copilot-conversations.sql";

const EXPECTED_COLUMNS = {
  ai_conversations: ["id", "user_id", "title", "status", "created_at", "updated_at", "last_message_at"],
  ai_conversation_messages: ["id", "conversation_id", "role", "content", "tool_call_log", "analysis_cards", "proposal_refs", "client_message_id", "created_at"],
};

const EXPECTED_INDEXES = {
  ai_conversations: ["ai_conversation_user_idx", "ai_conversation_user_last_message_idx"],
  ai_conversation_messages: ["ai_conversation_message_conversation_idx", "ai_conversation_message_client_id_uq"],
};

const EXPECTED_CHECK_CONSTRAINTS = {
  ai_conversations: "ai_conversation_status_chk",
  ai_conversation_messages: "ai_conversation_message_role_chk",
};

const EXPECTED_FKS = [
  { table: "ai_conversations", name: "ai_conversations_user_id_fk", refTable: "users" },
  { table: "ai_conversation_messages", name: "ai_conversation_messages_conversation_id_fk", refTable: "ai_conversations" },
];

// Bảng nghiệp vụ chính (kể cả `users`, vì migration THÊM một FK tham chiếu tới
// nó) — migration này KHÔNG được chạm vào dữ liệu, kiểm tra row count trước/sau.
const BUSINESS_TABLES = [
  "users",
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

console.log("\n=== BƯỚC 1: Chụp row count các bảng nghiệp vụ (kể cả users) TRƯỚC migration ===");
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

console.log("\n=== BƯỚC 4: Kiểm tra cấu trúc bảng ai_conversations / ai_conversation_messages ===");
let structureOk = true;
const missingColumnsByTable = {};
const missingIndexesByTable = {};
const missingCheckByTable = {};

for (const table of ["ai_conversations", "ai_conversation_messages"]) {
  const found = await tableExists(table);
  console.log(`\n  ${found ? "✅" : "❌"} Bảng ${table} tồn tại`);
  if (!found) {
    structureOk = false;
    continue;
  }

  const columnCheck = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
  const presentColumns = new Set(columnCheck.rows.map((r) => r.column_name));
  const missingColumns = EXPECTED_COLUMNS[table].filter((c) => !presentColumns.has(c));
  missingColumnsByTable[table] = missingColumns;
  console.log(`  Cột kỳ vọng (${table}):`);
  for (const c of EXPECTED_COLUMNS[table]) console.log(`    ${presentColumns.has(c) ? "✅" : "❌"} ${c}`);

  const pkCheck = await client.query(
    `SELECT a.attname FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary`,
    [`public.${table}`],
  );
  const pkColumns = pkCheck.rows.map((r) => r.attname);
  const pkOk = pkColumns.length === 1 && pkColumns[0] === "id";
  console.log(`  ${pkOk ? "✅" : "❌"} Primary key (${table}): [${pkColumns.join(", ")}]`);
  if (!pkOk) structureOk = false;

  const constraintCheck = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [`public.${table}`]);
  const constraintNames = constraintCheck.rows.map((r) => r.conname);
  const hasCheck = constraintNames.includes(EXPECTED_CHECK_CONSTRAINTS[table]);
  missingCheckByTable[table] = hasCheck ? [] : [EXPECTED_CHECK_CONSTRAINTS[table]];
  console.log(`  ${hasCheck ? "✅" : "❌"} CHECK constraint ${EXPECTED_CHECK_CONSTRAINTS[table]}`);

  const indexCheck = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`, [table]);
  const indexNames = new Set(indexCheck.rows.map((r) => r.indexname));
  const missingIdx = EXPECTED_INDEXES[table].filter((i) => !indexNames.has(i));
  missingIndexesByTable[table] = missingIdx;
  console.log(`  Index kỳ vọng (${table}):`);
  for (const idx of EXPECTED_INDEXES[table]) console.log(`    ${indexNames.has(idx) ? "✅" : "❌"} ${idx}`);
}

console.log("\n=== BƯỚC 5: Kiểm tra Foreign Key (ownership: user_id -> users.id, conversation_id -> ai_conversations.id) ===");
const fkCheck = await client.query(
  `SELECT conname, conrelid::regclass::text AS table_name, confrelid::regclass::text AS ref_table
   FROM pg_constraint WHERE contype = 'f' AND conname = ANY($1::text[])`,
  [EXPECTED_FKS.map((f) => f.name)],
);
// ::regclass::text bỏ qua tiền tố schema ("public.") khi schema đó nằm trên
// search_path (hành vi chuẩn của Postgres) — so sánh phải bỏ tiền tố "public."
// nếu có ở CẢ HAI phía, không giả định luôn có mặt.
const stripPublicSchema = (name) => name.replace(/^public\./, "");
const fkByName = new Map(fkCheck.rows.map((r) => [r.conname, r]));
let fksOk = true;
for (const fk of EXPECTED_FKS) {
  const row = fkByName.get(fk.name);
  const ok = Boolean(row) && stripPublicSchema(row.ref_table) === fk.refTable && stripPublicSchema(row.table_name) === fk.table;
  if (!ok) fksOk = false;
  console.log(`  ${ok ? "✅" : "❌"} ${fk.name}: ${fk.table}.* -> ${fk.refTable}.id${row ? ` (thực tế: ${row.table_name} -> ${row.ref_table})` : " (KHÔNG TÌM THẤY)"}`);
}

console.log("\n=== BƯỚC 6: Chụp row count các bảng nghiệp vụ (kể cả users) SAU migration, so sánh ===");
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
const allMissingColumns = Object.values(missingColumnsByTable).flat();
const allMissingIndexes = Object.values(missingIndexesByTable).flat();
const allMissingChecks = Object.values(missingCheckByTable).flat();
const allOk = structureOk && allMissingColumns.length === 0 && allMissingIndexes.length === 0 && allMissingChecks.length === 0 && fksOk && !businessRowsChanged;
if (allMissingColumns.length > 0) console.error(`❌ Thiếu cột: ${allMissingColumns.join(", ")}`);
if (allMissingIndexes.length > 0) console.error(`❌ Thiếu index: ${allMissingIndexes.join(", ")}`);
if (allMissingChecks.length > 0) console.error(`❌ Thiếu CHECK constraint: ${allMissingChecks.join(", ")}`);
if (!fksOk) console.error("❌ Thiếu hoặc sai Foreign Key.");
if (businessRowsChanged) console.error("❌ Row count của một bảng nghiệp vụ đã thay đổi — DỪNG LẠI, điều tra ngay.");
console.log(allOk ? "✅ PASS — ai_conversations/ai_conversation_messages đã tạo đúng cấu trúc, idempotent, không chạm dữ liệu nghiệp vụ (kể cả users)." : "❌ FAIL — xem chi tiết ở trên.");
process.exit(allOk ? 0 : 1);
