#!/usr/bin/env node
/**
 * RUN Electronic Confirmation deadline + engagement linkage MIGRATION —
 * PRODUCTION-SAFE, SCOPED.
 *
 * Runs ONLY migrations/2026-09-10-electronic-confirmation-deadline-engagement.sql
 * (two ADD COLUMN IF NOT EXISTS on candidate_documents, a deterministic
 * UPDATE of the new employment_session_id column ONLY, two CREATE INDEX IF
 * NOT EXISTS) — never the general migrations/*.sql sweep, never any other
 * pending migration. Mirrors scripts/run-ai-action-proposals-migration.mjs's
 * exact shape (same repo, same governance).
 *
 * Cách dùng:
 *   export DATABASE_URL=postgresql://...   # PROD_DATABASE_URL — KHÔNG dùng staging!
 *   node scripts/run-electronic-confirmation-deadline-engagement-migration.mjs
 *
 * An toàn: migration idempotent (ADD COLUMN/CREATE INDEX IF NOT EXISTS; the
 * UPDATE only touches rows where employment_session_id IS NULL, so re-running
 * it is a no-op for already-linked rows). Không DROP/TRUNCATE/DELETE, không
 * sửa cột hiện có, không chạm document_confirmations (nơi lưu evidence/
 * receipt/HMAC). Script này TỰ chứng minh:
 *   (a) row count của các bảng nghiệp vụ chính KHÔNG đổi trước/sau,
 *   (b) CONFIRMED count trong candidate_documents KHÔNG đổi,
 *   (c) pdf_sha256 của MỌI hồ sơ CONFIRMED KHÔNG đổi (so sánh trước/sau),
 *   (d) MỌI evidence field trong document_confirmations (receipt_id,
 *       confirmed_at_server, canonical_evidence_hash, evidence_hmac)
 *       KHÔNG đổi (so sánh trước/sau),
 *   (e) confirmation_deadline_at vẫn NULL cho 100% hồ sơ đã tồn tại trước
 *       migration — không có hồ sơ nào bị gán hạn hồi tố,
 *   (f) employment_session_id chỉ được gán khi khớp DUY NHẤT & CHẮC CHẮN
 *       (join qua employment_session_daily_app_uq) — hồ sơ không khớp được
 *       vẫn NULL, không đoán,
 *   (g) chạy lại migration lần 2 để chứng minh idempotent,
 *   (h) đọc-only: liệt kê số lao động (worker) có ≥2 employment_sessions
 *       độc lập, mỗi session sở hữu candidate_documents riêng — bằng chứng
 *       mô hình "returning worker" hoạt động đúng (không sửa gì, chỉ đếm).
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_FILE = "2026-09-10-electronic-confirmation-deadline-engagement.sql";

const EXPECTED_NEW_COLUMNS = ["employment_session_id", "confirmation_deadline_at"];
const EXPECTED_INDEXES = ["candidate_document_employment_session_idx", "candidate_document_status_deadline_idx"];

// Bảng nghiệp vụ chính — migration này KHÔNG được chạm vào (ngoại trừ
// candidate_documents, nơi CHỈ được thêm 2 cột mới + backfill 1 trong 2
// cột đó — không có hàng nào được thêm/xoá, không cột nào khác bị sửa).
const BUSINESS_TABLES = [
  "candidate_documents",
  "document_confirmations",
  "employment_sessions",
  "daily_applications",
  "worker_profiles",
  "workforce_movements",
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
      counts[t] = null;
      continue;
    }
    const r = await client.query(`SELECT count(*)::int AS c FROM ${t}`);
    counts[t] = r.rows[0].c;
  }
  return counts;
}

/** Deterministic checksum of every CONFIRMED candidate_documents row's (id, pdf_sha256) — proves the hash column is byte-for-byte untouched. */
async function confirmedPdfHashChecksum() {
  const r = await client.query(`SELECT id, pdf_sha256 FROM candidate_documents WHERE status = 'CONFIRMED' ORDER BY id`);
  const digest = createHash("sha256");
  for (const row of r.rows) digest.update(`${row.id}:${row.pdf_sha256}\n`);
  return { count: r.rows.length, checksum: digest.digest("hex") };
}

/** Deterministic checksum of EVERY document_confirmations row's evidence fields — proves the evidence/receipt/HMAC records are byte-for-byte untouched (this migration never writes to this table at all). */
async function confirmationEvidenceChecksum() {
  const r = await client.query(
    `SELECT id, candidate_document_id, receipt_id, confirmed_at_server, canonical_evidence_hash, evidence_hmac FROM document_confirmations ORDER BY id`,
  );
  const digest = createHash("sha256");
  for (const row of r.rows) {
    digest.update(`${row.id}:${row.candidate_document_id}:${row.receipt_id}:${row.confirmed_at_server?.toISOString()}:${row.canonical_evidence_hash}:${row.evidence_hmac}\n`);
  }
  return { count: r.rows.length, checksum: digest.digest("hex") };
}

console.log("\n=== BƯỚC 1: Chụp trạng thái các bảng nghiệp vụ TRƯỚC migration ===");
const before = await rowCounts(BUSINESS_TABLES);
for (const [t, c] of Object.entries(before)) console.log(`  ${t}: ${c === null ? "(không tồn tại)" : c}`);
const confirmedBefore = before.candidate_documents !== null ? (await client.query(`SELECT count(*)::int AS c FROM candidate_documents WHERE status = 'CONFIRMED'`)).rows[0].c : null;
console.log(`  candidate_documents(status=CONFIRMED): ${confirmedBefore}`);
const pdfChecksumBefore = await confirmedPdfHashChecksum();
console.log(`  pdf_sha256 checksum (${pdfChecksumBefore.count} CONFIRMED rows): ${pdfChecksumBefore.checksum}`);
const evidenceChecksumBefore = await confirmationEvidenceChecksum();
console.log(`  document_confirmations evidence checksum (${evidenceChecksumBefore.count} rows): ${evidenceChecksumBefore.checksum}`);

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

console.log("\n=== BƯỚC 4: Kiểm tra cấu trúc cột + index mới trên candidate_documents ===");
const columnCheck = await client.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'candidate_documents' AND column_name = ANY($1)`,
  [EXPECTED_NEW_COLUMNS],
);
const presentColumns = new Set(columnCheck.rows.map((r) => r.column_name));
const missingColumns = EXPECTED_NEW_COLUMNS.filter((c) => !presentColumns.has(c));
for (const c of EXPECTED_NEW_COLUMNS) console.log(`  ${presentColumns.has(c) ? "✅" : "❌"} column ${c}`);

const indexCheck = await client.query(
  `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'candidate_documents' AND indexname = ANY($1)`,
  [EXPECTED_INDEXES],
);
const presentIndexes = new Set(indexCheck.rows.map((r) => r.indexname));
const missingIndexes = EXPECTED_INDEXES.filter((i) => !presentIndexes.has(i));
for (const i of EXPECTED_INDEXES) console.log(`  ${presentIndexes.has(i) ? "✅" : "❌"} index ${i}`);

console.log("\n=== BƯỚC 5: Row count các bảng nghiệp vụ SAU migration, so sánh với TRƯỚC ===");
const after = await rowCounts(BUSINESS_TABLES);
let businessRowsChanged = false;
for (const t of BUSINESS_TABLES) {
  const b = before[t];
  const a = after[t];
  const same = b === a;
  if (!same) businessRowsChanged = true;
  console.log(`  ${same ? "✅" : "❌"} ${t}: trước=${b === null ? "(không tồn tại)" : b} sau=${a === null ? "(không tồn tại)" : a}`);
}

console.log("\n=== BƯỚC 6: CONFIRMED count + pdf_sha256 checksum SAU migration, so sánh với TRƯỚC ===");
const confirmedAfter = (await client.query(`SELECT count(*)::int AS c FROM candidate_documents WHERE status = 'CONFIRMED'`)).rows[0].c;
const confirmedCountSame = confirmedBefore === confirmedAfter;
console.log(`  ${confirmedCountSame ? "✅" : "❌"} CONFIRMED count: trước=${confirmedBefore} sau=${confirmedAfter}`);
const pdfChecksumAfter = await confirmedPdfHashChecksum();
const pdfChecksumSame = pdfChecksumBefore.checksum === pdfChecksumAfter.checksum && pdfChecksumBefore.count === pdfChecksumAfter.count;
console.log(`  ${pdfChecksumSame ? "✅" : "❌"} pdf_sha256 checksum: trước=${pdfChecksumBefore.checksum} (${pdfChecksumBefore.count} rows) sau=${pdfChecksumAfter.checksum} (${pdfChecksumAfter.count} rows)`);

console.log("\n=== BƯỚC 7: document_confirmations evidence checksum SAU migration, so sánh với TRƯỚC ===");
const evidenceChecksumAfter = await confirmationEvidenceChecksum();
const evidenceChecksumSame = evidenceChecksumBefore.checksum === evidenceChecksumAfter.checksum && evidenceChecksumBefore.count === evidenceChecksumAfter.count;
console.log(`  ${evidenceChecksumSame ? "✅" : "❌"} evidence checksum: trước=${evidenceChecksumBefore.checksum} (${evidenceChecksumBefore.count} rows) sau=${evidenceChecksumAfter.checksum} (${evidenceChecksumAfter.count} rows)`);

console.log("\n=== BƯỚC 8: confirmation_deadline_at KHÔNG được gán hồi tố cho bất kỳ hồ sơ nào ===");
const deadlineNotNullCount = (await client.query(`SELECT count(*)::int AS c FROM candidate_documents WHERE confirmation_deadline_at IS NOT NULL`)).rows[0].c;
const noRetroactiveDeadlines = deadlineNotNullCount === 0;
console.log(`  ${noRetroactiveDeadlines ? "✅" : "❌"} confirmation_deadline_at IS NOT NULL count: ${deadlineNotNullCount} (phải = 0)`);

console.log("\n=== BƯỚC 9: employment_session_id chỉ được gán khi khớp DUY NHẤT & CHẮC CHẮN ===");
const totalDocs = (await client.query(`SELECT count(*)::int AS c FROM candidate_documents`)).rows[0].c;
const linkedCount = (await client.query(`SELECT count(*)::int AS c FROM candidate_documents WHERE employment_session_id IS NOT NULL`)).rows[0].c;
const unlinkedCount = totalDocs - linkedCount;
console.log(`  ℹ️  Tổng candidate_documents: ${totalDocs} — đã liên kết (deterministic): ${linkedCount} — chưa liên kết (legacy/unlinked): ${unlinkedCount}`);
// Mọi hồ sơ ĐÃ liên kết phải trỏ đến ĐÚNG employment_sessions row có
// daily_application_id = application_id của chính nó — chứng minh liên kết
// là join xác định, không phải đoán.
const mismatchedLinks = (
  await client.query(
    `SELECT count(*)::int AS c FROM candidate_documents cd
     JOIN employment_sessions es ON es.id = cd.employment_session_id
     WHERE es.daily_application_id IS DISTINCT FROM cd.application_id`,
  )
).rows[0].c;
const linksAreDeterministic = mismatchedLinks === 0;
console.log(`  ${linksAreDeterministic ? "✅" : "❌"} Số liên kết SAI (employment_session.daily_application_id ≠ candidate_document.application_id): ${mismatchedLinks} (phải = 0)`);
// Mọi hồ sơ CHƯA liên kết phải thực sự KHÔNG có employment_sessions row
// khớp application_id — chứng minh KHÔNG có trường hợp khớp được nhưng bị bỏ sót.
const missedLinks = (
  await client.query(
    `SELECT count(*)::int AS c FROM candidate_documents cd
     WHERE cd.employment_session_id IS NULL
       AND EXISTS (SELECT 1 FROM employment_sessions es WHERE es.daily_application_id = cd.application_id)`,
  )
).rows[0].c;
const noMissedDeterministicLinks = missedLinks === 0;
console.log(`  ${noMissedDeterministicLinks ? "✅" : "❌"} Số hồ sơ CÓ THỂ khớp nhưng bị bỏ sót (chưa liên kết dù có employment_sessions khớp): ${missedLinks} (phải = 0)`);

console.log("\n=== BƯỚC 10 (đọc-only, thông tin): Mô hình 'returning worker' — lao động có ≥2 employment_sessions, mỗi session sở hữu candidate_documents riêng ===");
const returningWorkerRows = await client.query(
  `SELECT es.worker_id, count(DISTINCT es.id)::int AS session_count, count(DISTINCT cd.id)::int AS document_count
   FROM employment_sessions es
   JOIN candidate_documents cd ON cd.employment_session_id = es.id
   GROUP BY es.worker_id
   HAVING count(DISTINCT es.id) >= 2
   ORDER BY session_count DESC
   LIMIT 5`,
);
console.log(`  ℹ️  Số lao động có ≥2 employment_sessions, MỖI session sở hữu ≥1 candidate_documents riêng: ${returningWorkerRows.rows.length} (mẫu, tối đa 5 dòng đầu)`);
for (const row of returningWorkerRows.rows) {
  console.log(`     worker_id=${row.worker_id} sessions=${row.session_count} documents=${row.document_count}`);
}
console.log("  (Đây là bằng chứng đọc-only rằng mô hình 1-engagement-1-document hoạt động đúng trên dữ liệu thật — KHÔNG sửa/tạo gì.)");

await client.end();

console.log("\n=== KẾT QUẢ ===");
const allOk =
  missingColumns.length === 0 &&
  missingIndexes.length === 0 &&
  !businessRowsChanged &&
  confirmedCountSame &&
  pdfChecksumSame &&
  evidenceChecksumSame &&
  noRetroactiveDeadlines &&
  linksAreDeterministic &&
  noMissedDeterministicLinks;
if (missingColumns.length > 0) console.error(`❌ Thiếu cột: ${missingColumns.join(", ")}`);
if (missingIndexes.length > 0) console.error(`❌ Thiếu index: ${missingIndexes.join(", ")}`);
if (businessRowsChanged) console.error("❌ Row count của một bảng nghiệp vụ đã thay đổi — DỪNG LẠI, điều tra ngay.");
if (!confirmedCountSame) console.error("❌ CONFIRMED count đã thay đổi — DỪNG LẠI, điều tra ngay.");
if (!pdfChecksumSame) console.error("❌ pdf_sha256 của một hồ sơ CONFIRMED đã bị thay đổi — DỪNG LẠI, điều tra ngay.");
if (!evidenceChecksumSame) console.error("❌ Evidence trong document_confirmations đã bị thay đổi — DỪNG LẠI, điều tra ngay.");
if (!noRetroactiveDeadlines) console.error("❌ Có hồ sơ bị gán confirmation_deadline_at hồi tố — DỪNG LẠI, điều tra ngay.");
if (!linksAreDeterministic) console.error("❌ Có liên kết employment_session_id KHÔNG khớp application_id — DỪNG LẠI, điều tra ngay.");
if (!noMissedDeterministicLinks) console.error("❌ Có hồ sơ đáng lẽ khớp được nhưng bị bỏ sót — DỪNG LẠI, điều tra ngay.");
console.log(
  allOk
    ? "✅ PASS — cột/index đã tạo đúng, idempotent, không chạm evidence/receipt/hash hiện có, không gán hạn hồi tố, liên kết engagement chỉ khi chắc chắn."
    : "❌ FAIL — xem chi tiết ở trên.",
);
process.exit(allOk ? 0 : 1);
