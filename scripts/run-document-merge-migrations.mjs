#!/usr/bin/env node
/**
 * RUN DOCUMENT MERGE MIGRATIONS — PRODUCTION-SAFE, SCOPED.
 *
 * KHÁC với scripts/run-migrations.mjs (thiết kế cho fresh/staging DB — chạy
 * TOÀN BỘ schema.sql + TOÀN BỘ migrations/*.sql, kể cả các migration không
 * liên quan Document Merge): script này CHỈ chạy 8 migration Document Merge
 * cụ thể, theo đúng thứ tự khai báo bên dưới, trên 1 database ĐÃ CÓ schema
 * nền tảng (production) — không đụng tới bất kỳ bảng/migration nào khác.
 *
 * Cách dùng:
 *   export DATABASE_URL=postgresql://...   # PROD_DATABASE_URL — KHÔNG dùng staging!
 *   node scripts/run-document-merge-migrations.mjs
 *
 * An toàn: cả 8 migration đều idempotent (ADD COLUMN IF NOT EXISTS / CREATE
 * TABLE IF NOT EXISTS / ON CONFLICT DO NOTHING / WHERE NOT EXISTS). Không
 * DROP/TRUNCATE/DELETE. Không seed dữ liệu test/verification — chỉ seed
 * permissions hệ thống + 1 template thật (Đăng ký tập nghề) ở trạng thái
 * DRAFT (chưa publish). Chạy đi chạy lại nhiều lần luôn an toàn.
 *
 * INVARIANT SỐNG CÒN (sự cố production 2026-08-24): runner định kỳ này
 * KHÔNG BAO GIỜ được chứa migration cleanup xoá dữ liệu (destructive
 * DELETE). Migration 2026-08-24-trainee-registration-canonical-cleanup.sql
 * đã bị LOẠI KHỎI danh sách vĩnh viễn: nó chứa DELETE ... status != 'DRAFT'
 * — chạy lại đã xoá PUBLISHED v6 trên production. File đó chỉ còn tồn tại
 * trong git history, KHÔNG nằm trong danh sách chạy production định kỳ.
 * Mọi sửa chữa sự cố phải dùng migration forward-only, idempotent,
 * non-destructive (như ...-v7-incident-recovery.sql bên dưới).
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

// Đúng 8 migration Document Merge, ĐÚNG THỨ TỰ — KHÔNG đọc toàn bộ thư mục
// migrations/ (khác run-migrations.mjs) để không vô tình chạy migration của
// tính năng khác trên production (production có lịch sử migration riêng,
// không đảm bảo đồng bộ với danh sách file hiện tại của thư mục này).
//
// NGHIÊM CẤM thêm vào đây migration có DELETE/TRUNCATE/DROP xoá dữ liệu —
// xem khối INVARIANT ở đầu file (sự cố production 2026-08-24).
const DOCUMENT_MERGE_MIGRATIONS = [
  "2026-08-15-document-merge-engine.sql",
  "2026-08-17-document-merge-async-phase2.sql",
  "2026-08-17-document-merge-template-versions.sql",
  "2026-08-20-document-merge-async-pdf.sql",
  // Tombstone: obsolete 5-trang HTML seed đã bị gỡ khỏi migration này (chỉ còn
  // set html_enabled). KHÔNG seed document body nào.
  "2026-08-21-dang-ky-tap-nghe-html-draft.sql",
  // Canonical HTML hiện hành — tạo DRAFT mới, KHÔNG publish. Operator phải
  // Preview rồi bấm Xuất bản thì HTML_PDF mới dùng được.
  "2026-08-23-trainee-registration-canonical-html-draft.sql",
  // Recovery sự cố 2026-08-24 (forward-only, idempotent, NON-DESTRUCTIVE):
  // tạo lại ĐÚNG MỘT v7 DRAFT ở version 7 xác định nếu chưa có (dedupe theo
  // source_docx_name + SHA-256 body), và set current_published_version = NULL
  // CHỈ KHI nó trỏ vào version không còn tồn tại (fail closed). KHÔNG
  // publish, KHÔNG xoá gì. Chạy TRƯỚC v7 draft bên dưới để trong trạng thái
  // sự cố (versions trống) v7 rơi vào đúng version 7 thay vì MAX(version)+1.
  "2026-08-24-trainee-registration-v7-incident-recovery.sql",
  // v7 DRAFT từ operator test(2).html — KHÔNG publish. Idempotent: dedupe
  // theo source_docx_name nên chạy lại không tạo version trùng.
  "2026-08-24-trainee-registration-v7-operator-test2-draft.sql",
  // ⚠️ KHÔNG thêm "2026-08-24-trainee-registration-canonical-cleanup.sql"
  // vào đây — migration destructive (DELETE versions status != 'DRAFT'),
  // chỉ chạy MỘT LẦN trong lịch sử; chạy lại đã gây sự cố production.
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
