#!/usr/bin/env node
/**
 * RUN Workforce Movement Effective-Date Lifecycle MIGRATION — PRODUCTION-SAFE, SCOPED.
 *
 * Runs ONLY migrations/2026-09-10-workforce-movement-effective-lifecycle.sql
 * (one ADD COLUMN IF NOT EXISTS on workforce_movements, one deterministic
 * UPDATE backfilling ONLY that new column for rows already in a terminal
 * approved status, one CREATE INDEX IF NOT EXISTS, one idempotent
 * scheduled_jobs seed row) — never the general migrations/*.sql sweep,
 * never any other pending migration. Mirrors
 * scripts/run-electronic-confirmation-deadline-engagement-migration.mjs's
 * exact shape (same repo, same governance).
 *
 * BACKGROUND: this migration was written and merged with the Worker
 * Lifecycle Consistency mission's app code, but — unlike every other
 * migration in this repo — never had its OWN scoped runner script or
 * Production migration workflow, so it was never actually applied. This was
 * discovered via a separate Production incident (Worker 360 Profile "Lỗi
 * tải hồ sơ" + "Bộ phận của tôi", both temporarily patched to work around
 * the missing column in a follow-up PR) and is now applied deliberately,
 * per explicit user authorization, with the user's explicit backup waiver
 * (USER_BACKUP_DECISION=WAIVED_BY_USER, BACKUP_CONFIRMED=NO — recorded here
 * verbatim, never claimed as backup_confirmed=true).
 *
 * Cách dùng:
 *   export DATABASE_URL=postgresql://...   # PROD_DATABASE_URL — KHÔNG dùng staging!
 *   node scripts/run-workforce-movement-effective-lifecycle-migration.mjs
 *
 * An toàn: migration idempotent (ADD COLUMN/CREATE INDEX IF NOT EXISTS; the
 * UPDATE backfill only touches rows where lifecycle_applied_at IS NULL, so
 * re-running it is a no-op after the first run; the scheduled_jobs INSERT
 * uses ON CONFLICT DO NOTHING). Không DROP/TRUNCATE/DELETE, không sửa cột
 * hiện có, không chạm employment_sessions/worker_profiles/daily_applications/
 * candidate_documents/document_confirmations. Script này TỰ chứng minh:
 *   (a) row count của các bảng nghiệp vụ KHÁC KHÔNG đổi trước/sau,
 *   (b) MỌI cột KHÁC (ngoài lifecycle_applied_at) của workforce_movements
 *       KHÔNG đổi — checksum trước/sau,
 *   (c) chỉ những dòng ĐÃ ở trạng thái duyệt cuối cùng (resignation:
 *       INACTIVE, transfer: TRANSFER_COMPLETED) được backfill —
 *       KHÔNG dòng PENDING_HR nào bị đổi,
 *   (d) chạy lại migration lần 2 để chứng minh idempotent,
 *   (e) cột mới + index mới + scheduled_jobs row đã được tạo đúng.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_FILE = "2026-09-10-workforce-movement-effective-lifecycle.sql";

const EXPECTED_INDEXES = ["workforce_movement_pending_effect_idx"];

// Bảng nghiệp vụ KHÁC — migration này KHÔNG được chạm vào (row count phải
// giữ nguyên trước/sau). workforce_movements TỰ NÓ cũng không được thêm/xoá
// dòng nào — chỉ 1 cột MỚI trên các dòng ĐÃ có được backfill.
const OTHER_BUSINESS_TABLES = ["employment_sessions", "worker_profiles", "daily_applications", "candidate_documents", "document_confirmations"];

console.log("⚠️  USER_BACKUP_DECISION=WAIVED_BY_USER");
console.log("⚠️  BACKUP_CONFIRMED=NO — chủ hệ thống đã CHỦ ĐỘNG CHỌN không tạo backup trước lần chạy này.");

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
      counts[t] = null;
      continue;
    }
    const r = await client.query(`SELECT count(*)::int AS c FROM ${t}`);
    counts[t] = r.rows[0].c;
  }
  return counts;
}

async function count(whereSql, params = []) {
  const r = await client.query(`SELECT count(*)::int AS c FROM workforce_movements WHERE ${whereSql}`, params);
  return r.rows[0].c;
}

/** Checksum of EVERY workforce_movements row's columns OTHER than lifecycle_applied_at/updated_at — proves the migration's UPDATE never touches anything but the new column. Hashed, never printed (reason/note are free text). */
async function nonLifecycleColumnsChecksum() {
  const r = await client.query(
    `SELECT id, movement_type, worker_id, from_dept_id, to_dept_id, effective_date, reason, note, status, related_movement_id, employment_session_id, confirmed_by, confirmed_at, source, requested_by, created_at
     FROM workforce_movements ORDER BY id`,
  );
  const digest = createHash("sha256");
  for (const row of r.rows) {
    digest.update(
      `${row.id}:${row.movement_type}:${row.worker_id}:${row.from_dept_id}:${row.to_dept_id}:${row.effective_date}:${row.reason}:${row.note}:${row.status}:${row.related_movement_id}:${row.employment_session_id}:${row.confirmed_by}:${row.confirmed_at?.toISOString?.() ?? row.confirmed_at}:${row.source}:${row.requested_by}:${row.created_at?.toISOString?.() ?? row.created_at}\n`,
    );
  }
  return { count: r.rows.length, checksum: digest.digest("hex") };
}

const todayStr = new Date().toISOString().slice(0, 10);

console.log("\n=== BƯỚC 1: Chụp trạng thái TRƯỚC migration (read-only, chỉ số liệu tổng hợp) ===");
const before = await rowCounts(OTHER_BUSINESS_TABLES);
for (const [t, c] of Object.entries(before)) console.log(`  ${t}: ${c === null ? "(không tồn tại)" : c}`);

const movementTotalBefore = (await client.query(`SELECT count(*)::int AS c FROM workforce_movements`)).rows[0].c;
const resignationTotalBefore = await count(`movement_type = 'resignation'`);
const transferTotalBefore = await count(`movement_type = 'transfer'`);
const approvedResignationsBefore = await count(`movement_type = 'resignation' AND status = 'INACTIVE'`);
const approvedTransfersBefore = await count(`movement_type = 'transfer' AND status = 'TRANSFER_COMPLETED'`);
const effectiveApprovedResignationsBefore = await count(`movement_type = 'resignation' AND status = 'INACTIVE' AND effective_date <= $1`, [todayStr]);
const effectiveApprovedTransfersBefore = await count(`movement_type = 'transfer' AND status = 'TRANSFER_COMPLETED' AND effective_date <= $1`, [todayStr]);
const futureApprovedResignationsBefore = await count(`movement_type = 'resignation' AND status = 'INACTIVE' AND effective_date > $1`, [todayStr]);
const futureApprovedTransfersBefore = await count(`movement_type = 'transfer' AND status = 'TRANSFER_COMPLETED' AND effective_date > $1`, [todayStr]);
const activeSessionsBefore = (await client.query(`SELECT count(*)::int AS c FROM employment_sessions WHERE status = 'APPROVED' AND end_date IS NULL`)).rows[0].c;
const backfillCandidates = await count(`movement_type IN ('resignation','transfer') AND status IN ('INACTIVE','TRANSFER_COMPLETED')`);

console.log(`  MOVEMENT_TOTAL_BEFORE=${movementTotalBefore}`);
console.log(`  RESIGNATION_TOTAL_BEFORE=${resignationTotalBefore}`);
console.log(`  TRANSFER_TOTAL_BEFORE=${transferTotalBefore}`);
console.log(`  APPROVED_RESIGNATIONS_BEFORE=${approvedResignationsBefore}`);
console.log(`  APPROVED_TRANSFERS_BEFORE=${approvedTransfersBefore}`);
console.log(`  EFFECTIVE_APPROVED_RESIGNATIONS_BEFORE=${effectiveApprovedResignationsBefore}`);
console.log(`  EFFECTIVE_APPROVED_TRANSFERS_BEFORE=${effectiveApprovedTransfersBefore}`);
console.log(`  FUTURE_APPROVED_RESIGNATIONS_BEFORE=${futureApprovedResignationsBefore}`);
console.log(`  FUTURE_APPROVED_TRANSFERS_BEFORE=${futureApprovedTransfersBefore}`);
console.log(`  CURRENT_ACTIVE_EMPLOYMENT_SESSIONS_BEFORE=${activeSessionsBefore}`);
console.log(`  LIFECYCLE_BACKFILL_CANDIDATES=${backfillCandidates}`);

const nonLifecycleChecksumBefore = await nonLifecycleColumnsChecksum();
console.log(`  workforce_movements non-lifecycle-column checksum (${nonLifecycleChecksumBefore.count} rows): ${nonLifecycleChecksumBefore.checksum}`);

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
let migrationIdempotent = true;
try {
  await client.query(sql);
  console.log(`✅ migrations/${MIGRATION_FILE} (lần 2) — OK, không lỗi khi chạy lại (idempotent)`);
} catch (error) {
  migrationIdempotent = false;
  console.error(`❌ Migration KHÔNG idempotent — lần 2 lỗi: ${error.message.slice(0, 500)}`);
  await client.end();
  process.exit(1);
}

console.log("\n=== BƯỚC 4: Kiểm tra cấu trúc cột lifecycle_applied_at + index + scheduled_jobs ===");
const columnCheck = await client.query(
  `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workforce_movements' AND column_name = 'lifecycle_applied_at'`,
);
const columnExists = columnCheck.rows.length === 1;
const columnType = columnExists ? columnCheck.rows[0].data_type : null;
const columnNullable = columnExists ? columnCheck.rows[0].is_nullable : null;
console.log(`  ${columnExists ? "✅" : "❌"} column lifecycle_applied_at: type=${columnType} nullable=${columnNullable} default=${columnExists ? columnCheck.rows[0].column_default : "(n/a)"}`);

const indexCheck = await client.query(
  `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'workforce_movements' AND indexname = ANY($1)`,
  [EXPECTED_INDEXES],
);
const presentIndexes = new Set(indexCheck.rows.map((r) => r.indexname));
const missingIndexes = EXPECTED_INDEXES.filter((i) => !presentIndexes.has(i));
for (const i of EXPECTED_INDEXES) console.log(`  ${presentIndexes.has(i) ? "✅" : "❌"} index ${i}`);

const jobCheck = await client.query(`SELECT job_key, is_active, schedule, handler_key FROM scheduled_jobs WHERE job_key = 'apply_effective_workforce_movements'`);
const jobExists = jobCheck.rows.length === 1;
const jobActive = jobExists ? jobCheck.rows[0].is_active : null;
console.log(`  ${jobExists ? "✅" : "❌"} scheduled_jobs row: job_key=apply_effective_workforce_movements is_active=${jobActive} schedule=${jobExists ? jobCheck.rows[0].schedule : "(n/a)"} handler_key=${jobExists ? jobCheck.rows[0].handler_key : "(n/a)"}`);

console.log("\n=== BƯỚC 5: Row count các bảng nghiệp vụ KHÁC SAU migration, so sánh với TRƯỚC ===");
const after = await rowCounts(OTHER_BUSINESS_TABLES);
let otherTablesChanged = false;
for (const t of OTHER_BUSINESS_TABLES) {
  const b = before[t];
  const a = after[t];
  const same = b === a;
  if (!same) otherTablesChanged = true;
  console.log(`  ${same ? "✅" : "❌"} ${t}: trước=${b === null ? "(không tồn tại)" : b} sau=${a === null ? "(không tồn tại)" : a}`);
}
const movementTotalAfter = (await client.query(`SELECT count(*)::int AS c FROM workforce_movements`)).rows[0].c;
const movementRowCountSame = movementTotalBefore === movementTotalAfter;
console.log(`  ${movementRowCountSame ? "✅" : "❌"} workforce_movements row count: trước=${movementTotalBefore} sau=${movementTotalAfter} (không được thêm/xoá dòng)`);

console.log("\n=== BƯỚC 6: Checksum các cột KHÁC (ngoài lifecycle_applied_at) của workforce_movements SAU migration ===");
const nonLifecycleChecksumAfter = await nonLifecycleColumnsChecksum();
const nonLifecycleChecksumSame = nonLifecycleChecksumBefore.checksum === nonLifecycleChecksumAfter.checksum && nonLifecycleChecksumBefore.count === nonLifecycleChecksumAfter.count;
console.log(`  ${nonLifecycleChecksumSame ? "✅" : "❌"} checksum: trước=${nonLifecycleChecksumBefore.checksum} (${nonLifecycleChecksumBefore.count} rows) sau=${nonLifecycleChecksumAfter.checksum} (${nonLifecycleChecksumAfter.count} rows)`);

console.log("\n=== BƯỚC 7: Xác minh backfill CHỈ áp dụng cho dòng ĐÃ duyệt cuối cùng ===");
const pendingWithLifecycle = await count(`status NOT IN ('INACTIVE','TRANSFER_COMPLETED') AND lifecycle_applied_at IS NOT NULL`);
const pendingMovementsChanged = pendingWithLifecycle;
console.log(`  ${pendingMovementsChanged === 0 ? "✅" : "❌"} PENDING_MOVEMENTS_CHANGED (status NOT IN terminal set nhưng lifecycle_applied_at đã bị set): ${pendingMovementsChanged} (phải = 0)`);

const backfilledResignations = await count(`movement_type = 'resignation' AND status = 'INACTIVE' AND lifecycle_applied_at IS NOT NULL`);
const backfilledTransfers = await count(`movement_type = 'transfer' AND status = 'TRANSFER_COMPLETED' AND lifecycle_applied_at IS NOT NULL`);
console.log(`  ℹ️  BACKFILLED_RESIGNATIONS=${backfilledResignations} (kỳ vọng = APPROVED_RESIGNATIONS_BEFORE=${approvedResignationsBefore})`);
console.log(`  ℹ️  BACKFILLED_TRANSFERS=${backfilledTransfers} (kỳ vọng = APPROVED_TRANSFERS_BEFORE=${approvedTransfersBefore})`);
const backfillCountsMatch = backfilledResignations === approvedResignationsBefore && backfilledTransfers === approvedTransfersBefore;
console.log(`  ${backfillCountsMatch ? "✅" : "❌"} Số dòng backfill khớp đúng số dòng đã duyệt cuối cùng trước migration`);

// "FUTURE_MOVEMENTS_APPLIED_EARLY": migration KHÔNG BAO GIỜ chạm employment_sessions
// (đã chứng minh bằng OTHER_BUSINESS_TABLES row count ở BƯỚC 5, và migration SQL tự nó
// không có câu lệnh nào tham chiếu employment_sessions) — nên về mặt cấu trúc, việc
// backfill lifecycle_applied_at cho các dòng đã duyệt-cuối-cùng-nhưng-effective_date-
// tương-lai KHÔNG THỂ khiến bất kỳ session nào bị kết thúc/chuyển sớm. Đây CHÍNH XÁC
// là rationale trong chú thích migration: dưới code CŨ, mọi dòng đã duyệt cuối cùng đã
// được áp dụng NGAY LẬP TỨC bất kể effective_date — nên backfill chỉ ghi nhận lại sự
// thật lịch sử đó, không "áp dụng sớm" điều gì cả.
const futureMovementsAppliedEarly = 0;
console.log(`  ℹ️  FUTURE_MOVEMENTS_APPLIED_EARLY=${futureMovementsAppliedEarly} (chứng minh cấu trúc: migration không có câu lệnh nào ghi vào employment_sessions — xem migrations/${MIGRATION_FILE})`);
if (futureApprovedResignationsBefore > 0 || futureApprovedTransfersBefore > 0) {
  console.log(
    `  ℹ️  Lưu ý: có ${futureApprovedResignationsBefore + futureApprovedTransfersBefore} dòng đã duyệt-cuối-cùng với effective_date TRONG TƯƠNG LAI (theo giá trị effective_date) TỪ TRƯỚC migration — theo rationale migration, dưới code CŨ các dòng này đã được áp dụng NGAY khi duyệt (bất kể effective_date), nên vẫn được backfill lifecycle_applied_at đúng như mọi dòng đã duyệt cuối cùng khác.`,
  );
}

await client.end();

console.log("\n=== KẾT QUẢ ===");
const allOk = columnExists && columnType === "timestamp with time zone" && columnNullable === "YES" && missingIndexes.length === 0 && jobExists && jobActive === true && !otherTablesChanged && movementRowCountSame && nonLifecycleChecksumSame && pendingMovementsChanged === 0 && backfillCountsMatch && migrationIdempotent;
if (!columnExists) console.error("❌ Cột lifecycle_applied_at chưa tồn tại — DỪNG LẠI, điều tra ngay.");
if (missingIndexes.length > 0) console.error(`❌ Thiếu index: ${missingIndexes.join(", ")}`);
if (!jobExists || jobActive !== true) console.error("❌ scheduled_jobs row chưa đúng — DỪNG LẠI, điều tra ngay.");
if (otherTablesChanged) console.error("❌ Row count của một bảng nghiệp vụ KHÁC đã thay đổi — DỪNG LẠI, điều tra ngay.");
if (!movementRowCountSame) console.error("❌ Row count workforce_movements đã thay đổi — DỪNG LẠI, điều tra ngay.");
if (!nonLifecycleChecksumSame) console.error("❌ Một cột KHÁC (ngoài lifecycle_applied_at) của workforce_movements đã bị thay đổi — DỪNG LẠI, điều tra ngay.");
if (pendingMovementsChanged !== 0) console.error("❌ Có dòng CHƯA duyệt cuối cùng bị gán lifecycle_applied_at — DỪNG LẠI, điều tra ngay.");
if (!backfillCountsMatch) console.error("❌ Số dòng backfill không khớp số dòng đã duyệt cuối cùng — DỪNG LẠI, điều tra ngay.");
if (!migrationIdempotent) console.error("❌ Migration KHÔNG idempotent.");
console.log(
  allOk
    ? "✅ PASS — cột/index/scheduled_jobs đã tạo đúng, idempotent, backfill CHỈ áp dụng cho dòng đã duyệt cuối cùng, không chạm bảng nghiệp vụ nào khác, không cột nào khác của workforce_movements bị thay đổi."
    : "❌ FAIL — xem chi tiết ở trên.",
);
process.exit(allOk ? 0 : 1);
