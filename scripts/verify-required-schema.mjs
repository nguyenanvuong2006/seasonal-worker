#!/usr/bin/env node
/**
 * VERIFY REQUIRED SCHEMA — PDF Overlay /run-overlay (PR5 root-cause hardening).
 *
 * Chạy NGAY SAU migration (xem .github/workflows/migrate-staging.yml) hoặc độc
 * lập (operator) để chứng minh DB có ĐỦ bảng/cột mà /run-overlay cần — TRƯỚC
 * khi worker thực sự query. Fail (exit 1, SCHEMA_MISMATCH) nếu thiếu → một
 * migration KHÔNG thể "báo thành công" trong khi /run-overlay vẫn kỳ vọng schema
 * chưa sẵn sàng.
 *
 * Nguồn sự thật DUY NHẤT: src/lib/document-merge/pdf-overlay/required-schema.ts
 * — CÙNG contract mà worker-overlay-e2e.ts (/run-overlay) dùng → không có 2
 * danh sách hardcode dễ lệch nhau (drift).
 *
 * Cách chạy (chỉ CI/operator có network tới STAGING — KHÔNG chạy với DB production
 * nếu không chắc chắn):
 *
 *   export DATABASE_URL=postgresql://...        # Neon STAGING
 *   node --import tsx scripts/verify-required-schema.mjs
 *
 * Exit codes:
 *   0 = SCHEMA_OK (đủ bảng/cột, /run-overlay có thể chạy)
 *   1 = SCHEMA_MISMATCH (thiếu bảng/cột — chạy migration rồi verify lại)
 *   2 = lỗi kết nối/probe (DB không trả lời được information_schema)
 */
import pg from "pg";
import {
  REQUIRED_OVERLAY_SCHEMA,
  checkOverlaySchema,
  formatOverlaySchemaMismatch,
  OverlaySchemaError,
  isOverlaySchemaError,
} from "../src/lib/document-merge/pdf-overlay/required-schema.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL (Neon STAGING). KHÔNG dùng production nếu không chắc chắn!");
  process.exit(2);
}

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === "0" ? false : { rejectUnauthorized: false },
});

try {
  await client.connect();
  console.log(`✅ Kết nối DB: ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}`);

  // Adapter pg → SchemaQuerier (parity makeDrizzleSchemaQuerier ở worker).
  const querier = async (sqlText) => (await client.query(sqlText)).rows;

  const result = await checkOverlaySchema(querier);

  console.log("------------------------------------------------------------------------");
  console.log(`Required tables: ${result.requiredTableCount} | Observed present: ${result.observedTableCount}`);
  for (const required of REQUIRED_OVERLAY_SCHEMA) {
    const present = !result.missingTables.includes(required.table)
      && !result.missingColumns.some((m) => m.table === required.table);
    const note = result.missingTables.includes(required.table)
      ? "THIẾU BẢNG"
      : (result.missingColumns.find((m) => m.table === required.table)?.columns.join(", ") ?? "");
    console.log(`  ${present ? "✅" : "❌"} ${required.table}${note ? ` — ${note}` : ""}`);
  }
  console.log("------------------------------------------------------------------------");

  if (result.ok) {
    console.log("✅ SCHEMA_OK: /run-overlay schema sẵn sàng (đủ bảng/cột bắt buộc).");
    process.exit(0);
  }

  console.error("❌ " + formatOverlaySchemaMismatch(result));
  process.exit(1);
} catch (error) {
  if (isOverlaySchemaError(error)) {
    console.error("❌ " + error.message);
    process.exit(1);
  }
  console.error("❌ Lỗi kiểm tra schema (DB không trả lời information_schema?):", error?.message ?? String(error));
  process.exit(2);
} finally {
  await client.end().catch(() => undefined);
}
