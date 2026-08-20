#!/usr/bin/env node
/**
 * RUN DOCUMENT MERGE MIGRATIONS — PRODUCTION-SAFE, SCOPED.
 *
 * KHÁC với scripts/run-migrations.mjs (thiết kế cho fresh/staging DB — chạy
 * TOÀN BỘ schema.sql + TOÀN BỘ migrations/*.sql, kể cả các migration không
 * liên quan Document Merge): script này CHỈ chạy 5 migration Document Merge
 * cụ thể, theo đúng thứ tự filename, trên 1 database ĐÃ CÓ schema nền tảng
 * (production) — không đụng tới bất kỳ bảng/migration nào khác.
 *
 * Cách dùng:
 *   export DATABASE_URL=postgresql://...   # PROD_DATABASE_URL — KHÔNG dùng staging!
 *   node scripts/run-document-merge-migrations.mjs
 *
 * An toàn: cả 5 migration đều idempotent (ADD COLUMN IF NOT EXISTS / CREATE
 * TABLE IF NOT EXISTS / ON CONFLICT DO NOTHING / WHERE NOT EXISTS). Không
 * DROP/TRUNCATE/DELETE. Không seed dữ liệu test/verification — chỉ seed
 * permissions hệ thống + 1 template thật (Đăng ký tập nghề) ở trạng thái
 * DRAFT (chưa publish).
 *
 * Dừng ngay ở migration đầu tiên lỗi (không tiếp tục "cho có kết quả").
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL (PROD_DATABASE_URL). KHÔNG chạy nếu không chắc chắn đây là production!");
  process.exit(1);
}

// Đúng 5 migration Document Merge, ĐÚNG THỨ TỰ — KHÔNG đọc toàn bộ thư mục
// migrations/ (khác run-migrations.mjs) để không vô tình chạy migration của
// tính năng khác trên production (production có lịch sử migration riêng,
// không đảm bảo đồng bộ với danh sách file hiện tại của thư mục này).
const DOCUMENT_MERGE_MIGRATIONS = [
  "2026-08-15-document-merge-engine.sql",
  "2026-08-17-document-merge-async-phase2.sql",
  "2026-08-17-document-merge-template-versions.sql",
  "2026-08-20-document-merge-async-pdf.sql",
  "2026-08-21-dang-ky-tap-nghe-html-draft.sql",
];

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
// Không log connection string đầy đủ — chỉ host (an toàn, không phải secret).
const host = (() => {
  try {
    return new URL(DATABASE_URL).hostname;
  } catch {
    return "(không parse được host)";
  }
})();
console.log(`✅ Kết nối DB: host=${host}`);

const results = [];
for (const filename of DOCUMENT_MERGE_MIGRATIONS) {
  const sql = readFileSync(join(ROOT, "migrations", filename), "utf8");
  try {
    await client.query(sql);
    results.push({ filename, ok: true });
    console.log(`  ✅ migrations/${filename}`);
  } catch (error) {
    results.push({ filename, ok: false, error: error.message.slice(0, 500) });
    console.error(`  ❌ migrations/${filename}: ${error.message.slice(0, 500)}`);
    // Dừng NGAY ở lỗi đầu tiên — không chạy tiếp migration sau khi 1 cái đã lỗi.
    break;
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== RESULT: ${results.length - failed.length}/${DOCUMENT_MERGE_MIGRATIONS.length} PASS ===`);
if (failed.length > 0 || results.length < DOCUMENT_MERGE_MIGRATIONS.length) {
  await client.end();
  process.exit(1);
}

// Verify: đúng 7 bảng Document Merge phải tồn tại — CHỈ đếm, không đọc data thật.
const EXPECTED_TABLES = [
  "merge_templates",
  "merge_template_fields",
  "merge_template_versions",
  "merge_jobs",
  "merge_job_records",
  "document_history",
  "archive_runs",
];
const tableCheck = await client.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
  [EXPECTED_TABLES],
);
const present = new Set(tableCheck.rows.map((r) => r.table_name));
const missingTables = EXPECTED_TABLES.filter((t) => !present.has(t));

console.log("\n=== TABLE EXISTENCE ===");
for (const t of EXPECTED_TABLES) console.log(`  ${present.has(t) ? "✅" : "❌"} ${t}`);

if (missingTables.length > 0) {
  console.error(`\n❌ Thiếu bảng: ${missingTables.join(", ")}`);
  await client.end();
  process.exit(1);
}

// Report COUNTS ONLY — không dump dữ liệu.
const counts = await client.query(`
  SELECT
    (SELECT count(*) FROM merge_templates) AS templates,
    (SELECT count(*) FROM merge_template_fields WHERE is_orphaned = false) AS fields,
    (SELECT count(*) FROM merge_template_versions) AS versions,
    (SELECT count(*) FROM merge_template_versions WHERE status = 'PUBLISHED') AS published_versions,
    (SELECT count(*) FROM merge_jobs) AS jobs,
    (SELECT count(*) FROM document_history) AS history
`);
console.log("\n=== COUNTS ===");
console.log(JSON.stringify(counts.rows[0]));

console.log("\n✅ Document Merge migrations OK. Engine vẫn GOOGLE_DOCS cho tới khi được kích hoạt thủ công.");
await client.end();
