#!/usr/bin/env node
/**
 * ONE-OFF, MANUALLY-DISPATCHED PR #114 PRODUCTION ROLLOUT — assignment actor
 * freeze schema, Nguoi_tiep_nhan mapping, v12 DRAFT layout.
 *
 * Companion script for .github/workflows/rollout-pr114-assignment-v12.yml —
 * NOT part of the periodic scripts/run-document-merge-migrations.mjs list
 * (that script's fixed migration list is unrelated and must not be touched).
 *
 * Runs EXACTLY ONE step per invocation, selected by the ROLLOUT_STEP env var:
 *   schema     -> migrations/2026-08-26-assignment-actor-freeze.sql
 *   mapping    -> migrations/2026-08-26-nguoi-tiep-nhan-assigned-by-display-name.sql
 *   v12-draft  -> migrations/2026-08-26-trainee-registration-v12-layout-draft.sql
 *
 * Safety:
 *   - Each step runs ONLY its own single migration file — never more than one.
 *   - Every step does a read-only pre-check first and refuses to run if its
 *     prerequisites are not met (fail closed, no guessing/backfilling).
 *   - No DROP/DELETE/mass backfill anywhere in this script or the 3 migrations
 *     it runs. No publish. No current_published_version change. No v11 mutation.
 *   - DATABASE_URL is never logged — only the sanitized hostname.
 *   - Stops at the first SQL error (ON_ERROR_STOP equivalent — pg's simple
 *     query protocol wraps a multi-statement file in an implicit transaction,
 *     so a mid-file failure rolls the whole file back, not just stops after it).
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
const STEP = process.env.ROLLOUT_STEP;

const VALID_STEPS = ["schema", "mapping", "v12-draft"];
const V11_GOOGLE_DOC_ID = "10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE";

if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL (PROD_DATABASE_URL). KHÔNG chạy nếu không chắc chắn đây là production!");
  process.exit(1);
}
if (!VALID_STEPS.includes(STEP)) {
  console.error(`❌ ROLLOUT_STEP không hợp lệ: "${STEP}". Phải là một trong: ${VALID_STEPS.join(", ")}.`);
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
console.log(`▶ ROLLOUT_STEP=${STEP}\n`);

function readMigration(filename) {
  return readFileSync(join(ROOT, "migrations", filename), "utf8");
}

async function columnsPresent(table, columns) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
    [table, columns],
  );
  const present = new Set(rows.map((r) => r.column_name));
  return Object.fromEntries(columns.map((c) => [c, present.has(c)]));
}

async function fail(message) {
  console.error(`\n❌ ${message}`);
  await client.end();
  process.exit(1);
}

/* ============================================================
   STEP = schema
   ============================================================ */
async function runSchema() {
  console.log("=== Pre-check: assignment actor columns BEFORE ===");
  const dailyBefore = await columnsPresent("daily_applications", ["assigned_by", "assigned_by_display_name", "assigned_at"]);
  const sessionBefore = await columnsPresent("employment_sessions", ["assigned_by", "assigned_by_display_name", "assigned_at"]);
  console.log("daily_applications:", JSON.stringify(dailyBefore));
  console.log("employment_sessions:", JSON.stringify(sessionBefore));

  console.log("\n=== Running ONLY migrations/2026-08-26-assignment-actor-freeze.sql ===");
  try {
    await client.query(readMigration("2026-08-26-assignment-actor-freeze.sql"));
    console.log("  ✅ migrations/2026-08-26-assignment-actor-freeze.sql");
  } catch (error) {
    await fail(`Migration lỗi (đã rollback theo implicit transaction): ${error.message.slice(0, 500)}`);
  }

  console.log("\n=== Read-back: assignment actor columns AFTER ===");
  const dailyAfter = await columnsPresent("daily_applications", ["assigned_by", "assigned_by_display_name", "assigned_at"]);
  const sessionAfter = await columnsPresent("employment_sessions", ["assigned_by", "assigned_by_display_name", "assigned_at"]);
  console.log("daily_applications:", JSON.stringify(dailyAfter));
  console.log("employment_sessions:", JSON.stringify(sessionAfter));

  const allPresent = Object.values(dailyAfter).every(Boolean) && Object.values(sessionAfter).every(Boolean);
  console.log(`\nALL_ACTOR_COLUMNS_PRESENT=${allPresent ? "yes" : "no"}`);
  if (!allPresent) {
    await fail("Không đủ 6 cột assignment actor sau khi chạy migration — KHÔNG tự sửa, báo operator kiểm tra thủ công.");
  }
  console.log("\n✅ STEP=schema hoàn tất. KHÔNG chạm mapping. KHÔNG tạo v12.");
}

/* ============================================================
   STEP = mapping
   ============================================================ */
async function runMapping() {
  console.log("=== Pre-check: schema columns phải tồn tại TRƯỚC ===");
  const daily = await columnsPresent("daily_applications", ["assigned_by", "assigned_by_display_name", "assigned_at"]);
  const session = await columnsPresent("employment_sessions", ["assigned_by", "assigned_by_display_name", "assigned_at"]);
  const schemaReady = Object.values(daily).every(Boolean) && Object.values(session).every(Boolean);
  console.log("daily_applications:", JSON.stringify(daily));
  console.log("employment_sessions:", JSON.stringify(session));
  if (!schemaReady) {
    await fail("Schema assignment actor CHƯA đủ 6 cột — chạy STEP=schema trước. KHÔNG tự chạy mapping khi schema thiếu.");
  }
  console.log("✅ Schema đã sẵn sàng.");
  console.log(
    "⚠️  Script này KHÔNG thể tự xác minh ASSIGNMENT_ACTOR_WRITE_ENABLED=1 trên Vercel hay việc redeploy đã xong " +
      "(không có quyền truy cập Vercel) — đây là 2 tiền điều kiện operator phải tự xác nhận trước khi chạy bước này.",
  );

  console.log("\n=== Snapshot mapping/version TRƯỚC khi chạy ===");
  const before = await client.query(
    `SELECT mf.source_field, mf.updated_at
     FROM merge_template_fields mf
     JOIN merge_templates t ON mf.template_id = t.id
     WHERE t.google_doc_id = $1 AND mf.placeholder = 'Nguoi_tiep_nhan'`,
    [V11_GOOGLE_DOC_ID],
  );
  console.log("Nguoi_tiep_nhan (current mapping) BEFORE:", JSON.stringify(before.rows));

  const publishedBefore = await client.query(
    `SELECT v.version, v.status, v.mapping_snapshot
     FROM merge_template_versions v
     JOIN merge_templates t ON v.template_id = t.id
     WHERE t.google_doc_id = $1 AND v.status = 'PUBLISHED'`,
    [V11_GOOGLE_DOC_ID],
  );
  if (publishedBefore.rows.length !== 1) {
    console.log(`⚠️  Không tìm thấy đúng 1 version PUBLISHED (tìm thấy ${publishedBefore.rows.length}) — vẫn tiếp tục, chỉ để so sánh trước/sau.`);
  }
  const publishedSnapshotBefore = JSON.stringify(publishedBefore.rows.map((r) => ({ version: r.version, mapping_snapshot: r.mapping_snapshot })));

  console.log("\n=== Running ONLY migrations/2026-08-26-nguoi-tiep-nhan-assigned-by-display-name.sql ===");
  try {
    await client.query(readMigration("2026-08-26-nguoi-tiep-nhan-assigned-by-display-name.sql"));
    console.log("  ✅ migrations/2026-08-26-nguoi-tiep-nhan-assigned-by-display-name.sql");
  } catch (error) {
    await fail(`Migration lỗi (đã rollback theo implicit transaction): ${error.message.slice(0, 500)}`);
  }

  console.log("\n=== Read-back: mapping AFTER ===");
  const after = await client.query(
    `SELECT mf.source_field, mf.updated_at
     FROM merge_template_fields mf
     JOIN merge_templates t ON mf.template_id = t.id
     WHERE t.google_doc_id = $1 AND mf.placeholder = 'Nguoi_tiep_nhan'`,
    [V11_GOOGLE_DOC_ID],
  );
  console.log("Nguoi_tiep_nhan (current mapping) AFTER:", JSON.stringify(after.rows));
  const mappingKey = after.rows[0]?.source_field;
  console.log(`\nNGUOI_TIEP_NHAN_MAPPING_AFTER=${mappingKey ?? "(không tìm thấy row)"}`);

  const publishedAfter = await client.query(
    `SELECT v.version, v.status, v.mapping_snapshot
     FROM merge_template_versions v
     JOIN merge_templates t ON v.template_id = t.id
     WHERE t.google_doc_id = $1 AND v.status = 'PUBLISHED'`,
    [V11_GOOGLE_DOC_ID],
  );
  const publishedSnapshotAfter = JSON.stringify(publishedAfter.rows.map((r) => ({ version: r.version, mapping_snapshot: r.mapping_snapshot })));
  const snapshotUnchanged = publishedSnapshotBefore === publishedSnapshotAfter;
  console.log(`V11_MAPPING_SNAPSHOT_CHANGED=${snapshotUnchanged ? "no" : "yes"}`);

  if (mappingKey !== "ASSIGNED_BY_DISPLAY_NAME") {
    await fail(`Nguoi_tiep_nhan mapping sau migration KHÔNG phải ASSIGNED_BY_DISPLAY_NAME (thực tế: ${mappingKey}) — dừng, không tiếp tục v12.`);
  }
  if (!snapshotUnchanged) {
    await fail("CRITICAL: v11 PUBLISHED mapping_snapshot đã bị thay đổi bởi migration này — đây KHÔNG được phép xảy ra. Báo operator ngay.");
  }
  console.log("\n✅ STEP=mapping hoàn tất. v11 mapping_snapshot không đổi. KHÔNG tạo v12.");
}

/* ============================================================
   STEP = v12-draft
   ============================================================ */
async function runV12Draft() {
  console.log("=== Pre-check trước khi tạo v12 ===");
  const daily = await columnsPresent("daily_applications", ["assigned_by", "assigned_by_display_name", "assigned_at"]);
  const session = await columnsPresent("employment_sessions", ["assigned_by", "assigned_by_display_name", "assigned_at"]);
  const schemaReady = Object.values(daily).every(Boolean) && Object.values(session).every(Boolean);
  console.log(`Schema ready: ${schemaReady}`);
  if (!schemaReady) {
    await fail("Schema assignment actor CHƯA đủ 6 cột — chạy STEP=schema trước.");
  }

  const mappingRow = await client.query(
    `SELECT mf.source_field FROM merge_template_fields mf
     JOIN merge_templates t ON mf.template_id = t.id
     WHERE t.google_doc_id = $1 AND mf.placeholder = 'Nguoi_tiep_nhan'`,
    [V11_GOOGLE_DOC_ID],
  );
  const mappingKey = mappingRow.rows[0]?.source_field;
  console.log(`Nguoi_tiep_nhan current mapping: ${mappingKey}`);
  if (mappingKey !== "ASSIGNED_BY_DISPLAY_NAME") {
    await fail(`Nguoi_tiep_nhan mapping chưa phải ASSIGNED_BY_DISPLAY_NAME (thực tế: ${mappingKey}) — chạy STEP=mapping trước.`);
  }

  const templateRow = await client.query(`SELECT id, current_published_version FROM merge_templates WHERE google_doc_id = $1 ORDER BY created_at ASC LIMIT 1`, [V11_GOOGLE_DOC_ID]);
  if (templateRow.rows.length !== 1) {
    await fail(`Không tìm thấy đúng 1 template với google_doc_id=${V11_GOOGLE_DOC_ID} (tìm thấy ${templateRow.rows.length}).`);
  }
  const templateId = templateRow.rows[0].id;
  const publishedVersionBefore = templateRow.rows[0].current_published_version;
  console.log(`current_published_version BEFORE: ${publishedVersionBefore}`);

  const publishedStatus = await client.query(`SELECT version, status FROM merge_template_versions WHERE template_id = $1 AND version = $2`, [templateId, publishedVersionBefore]);
  const v11StillPublished = publishedStatus.rows[0]?.status === "PUBLISHED";
  console.log(`V11_STILL_PUBLISHED (pre-check)=${v11StillPublished ? "yes" : "no"}`);
  if (!v11StillPublished) {
    await fail(`Version ${publishedVersionBefore} (current_published_version) không ở trạng thái PUBLISHED — dừng lại, không tạo v12 trên nền không ổn định.`);
  }

  const existingV12 = await client.query(`SELECT id, version, status FROM merge_template_versions WHERE template_id = $1 AND version = 12`, [templateId]);
  console.log(`V12_ALREADY_EXISTS (pre-check)=${existingV12.rows.length > 0 ? "yes" : "no"} (${existingV12.rows.length} row(s))`);
  if (existingV12.rows.length > 1) {
    await fail(`Đã có ${existingV12.rows.length} dòng version=12 — trạng thái bất thường, dừng lại cho operator kiểm tra thủ công, KHÔNG tự sửa.`);
  }
  if (existingV12.rows.length === 1 && existingV12.rows[0].status !== "DRAFT") {
    await fail(`v12 đã tồn tại nhưng status=${existingV12.rows[0].status} (không phải DRAFT) — dừng lại, không phải trạng thái an toàn dự kiến.`);
  }

  if (existingV12.rows.length === 1) {
    console.log("\nℹ️  v12 đã tồn tại đúng như kỳ vọng (DRAFT) — KHÔNG chạy lại migration để tránh tạo trùng, chỉ đọc lại xác nhận.");
  } else {
    console.log("\n=== Running ONLY migrations/2026-08-26-trainee-registration-v12-layout-draft.sql ===");
    try {
      await client.query(readMigration("2026-08-26-trainee-registration-v12-layout-draft.sql"));
      console.log("  ✅ migrations/2026-08-26-trainee-registration-v12-layout-draft.sql");
    } catch (error) {
      await fail(`Migration lỗi (đã rollback theo implicit transaction): ${error.message.slice(0, 500)}`);
    }
  }

  console.log("\n=== Read-back sau khi tạo v12 ===");
  const v12Rows = await client.query(`SELECT version, status FROM merge_template_versions WHERE template_id = $1 AND version = 12`, [templateId]);
  const templateAfter = await client.query(`SELECT current_published_version FROM merge_templates WHERE id = $1`, [templateId]);
  const publishedVersionAfter = templateAfter.rows[0].current_published_version;
  const v11StatusAfter = await client.query(`SELECT status FROM merge_template_versions WHERE template_id = $1 AND version = $2`, [templateId, publishedVersionBefore]);

  console.log(`V12_DRAFT_CREATED=${v12Rows.rows.length > 0 ? "yes" : "no"}`);
  console.log(`V12_VERSION=${v12Rows.rows[0]?.version ?? "n/a"}`);
  console.log(`V12_STATUS=${v12Rows.rows[0]?.status ?? "n/a"}`);
  console.log(`DUPLICATE_V12_ROWS=${v12Rows.rows.length > 1 ? "yes" : "no"} (count=${v12Rows.rows.length})`);
  console.log(`CURRENT_PUBLISHED_VERSION_CHANGED=${publishedVersionAfter !== publishedVersionBefore ? "yes" : "no"} (before=${publishedVersionBefore}, after=${publishedVersionAfter})`);
  console.log(`V11_STILL_PUBLISHED=${v11StatusAfter.rows[0]?.status === "PUBLISHED" ? "yes" : "no"}`);

  if (v12Rows.rows.length !== 1) await fail(`Kỳ vọng đúng 1 dòng version=12, thực tế ${v12Rows.rows.length}.`);
  if (v12Rows.rows[0].status !== "DRAFT") await fail(`v12 status = ${v12Rows.rows[0].status}, KHÔNG PHẢI DRAFT — CRITICAL STOP.`);
  if (publishedVersionAfter !== publishedVersionBefore) await fail("CRITICAL: current_published_version đã bị thay đổi — KHÔNG được phép xảy ra.");
  if (v11StatusAfter.rows[0]?.status !== "PUBLISHED") await fail("CRITICAL: version PUBLISHED trước đó không còn PUBLISHED sau khi tạo v12.");

  console.log("\n✅ STEP=v12-draft hoàn tất. v12=DRAFT, v11 vẫn PUBLISHED, current_published_version không đổi, không có bản ghi v12 trùng. KHÔNG publish.");
}

try {
  if (STEP === "schema") await runSchema();
  else if (STEP === "mapping") await runMapping();
  else if (STEP === "v12-draft") await runV12Draft();
} finally {
  await client.end();
}
