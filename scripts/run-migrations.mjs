#!/usr/bin/env node
/**
 * RUN MIGRATIONS — cho Neon staging / fresh database.
 *
 * Cách dùng:
 *   export DATABASE_URL=postgresql://...   # Neon STAGING (KHÔNG dùng production!)
 *   node scripts/run-migrations.mjs
 *
 * Thứ tự:
 *   1. schema.sql (phần core — cắt các block merge vì bảng merge_* do migration tạo)
 *   2. migrations/*.sql theo thứ tự filename sort (cơ chế chuẩn của repo)
 *
 * An toàn: migrations đều idempotent (IF NOT EXISTS / ON CONFLICT / WHERE NOT EXISTS).
 * KHÔNG destructive. Chạy lại nhiều lần không lỗi.
 */
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL (Neon staging). KHÔNG dùng production nếu không chắc chắn!");
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
console.log(`✅ Kết nối DB: ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}`);

const results = [];
const fail = (label, err) => { results.push({ label, ok: false, error: err.message.slice(0, 300) }); console.error(`  ❌ ${label}: ${err.message.slice(0, 300)}`); };
const pass = (label) => { results.push({ label, ok: true }); console.log(`  ✅ ${label}`); };

// 1. Schema core
const schemaFull = readFileSync(join(ROOT, "schema.sql"), "utf8");
let end = schemaFull.length;
for (const marker of [
  "CẬP NHẬT 2026-08-15 — DOCUMENT MERGE + KÝ NHẬN HỒ SƠ TẬP NGHỀ",
  "DOCUMENT MERGE — ASYNC HTML/PDF ENGINE (Phase 2)",
]) {
  const idx = schemaFull.indexOf(marker);
  if (idx >= 0) {
    const bs = schemaFull.lastIndexOf("-- ============================================================", idx);
    if (bs >= 0 && bs < end) end = bs;
  }
}
try { await client.query(schemaFull.slice(0, end)); pass("schema.sql (core)"); }
catch (e) { fail("schema.sql (core)", e); throw e; }

// 2. Migrations
const files = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  const sql = readFileSync(join(ROOT, "migrations", f), "utf8");
  try {
    await client.query(sql);
    pass(`migrations/${f}`);
  } catch (e) { fail(`migrations/${f}`, e); }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== RESULT: ${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL ===`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED: ${f.label} — ${f.error}`);
  process.exit(1);
}
console.log("✅ Fresh DB sẵn sàng — template + mappings + version DRAFT v1 đã seed.");
await client.end();
