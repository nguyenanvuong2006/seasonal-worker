#!/usr/bin/env node
/**
 * RUN recruitment_requests SNAPSHOT COLUMNS HOTFIX — PRODUCTION-SAFE, SCOPED.
 *
 * Runs ONLY migrations/2026-09-09-recruitment-requests-snapshot-columns-only.sql
 * (four ADD COLUMN IF NOT EXISTS statements) — never the general
 * migrations/*.sql sweep, never the original 2026-08-19 backfill/recompute
 * migration. See that file's own docblock for the full incident/root-cause
 * writeup and why the backfill+recompute is deliberately excluded here.
 *
 * Cách dùng:
 *   export DATABASE_URL=postgresql://...   # PROD_DATABASE_URL — KHÔNG dùng staging!
 *   node scripts/run-recruitment-snapshot-columns-migration.mjs
 *
 * An toàn: migration idempotent (ADD COLUMN IF NOT EXISTS). Không
 * DROP/TRUNCATE/DELETE. Không sửa dữ liệu nghiệp vụ hiện có.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_FILE = "2026-09-09-recruitment-requests-snapshot-columns-only.sql";
const EXPECTED_COLUMNS = ["male_current_at_start", "female_current_at_start", "total_current_at_start", "snapshot_at"];

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

const sql = readFileSync(join(ROOT, "migrations", MIGRATION_FILE), "utf8");
try {
  await client.query(sql);
  console.log(`✅ migrations/${MIGRATION_FILE}`);
} catch (error) {
  console.error(`❌ migrations/${MIGRATION_FILE}: ${error.message.slice(0, 500)}`);
  await client.end();
  process.exit(1);
}

// Verify: đúng 4 cột phải tồn tại — CHỈ kiểm tra cấu trúc, không đọc data thật.
const columnCheck = await client.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'recruitment_requests' AND column_name = ANY($1)`,
  [EXPECTED_COLUMNS],
);
const present = new Set(columnCheck.rows.map((r) => r.column_name));
const missing = EXPECTED_COLUMNS.filter((c) => !present.has(c));

console.log("\n=== COLUMN EXISTENCE (recruitment_requests) ===");
for (const c of EXPECTED_COLUMNS) console.log(`  ${present.has(c) ? "✅" : "❌"} ${c}`);

await client.end();

if (missing.length > 0) {
  console.error(`\n❌ Thiếu cột: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("\n=== RESULT: PASS ===");
