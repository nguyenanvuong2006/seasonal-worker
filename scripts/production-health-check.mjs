#!/usr/bin/env node
/**
 * PRODUCTION HEALTH CHECK — READ-ONLY (Phase 10)
 * ------------------------------------------------------------
 * Script này CHỈ thực hiện các SELECT — KHÔNG insert/update/delete.
 * Dùng để xác nhận production đang ở trạng thái nào trước khi deploy.
 *
 * Cách chạy:
 *   DATABASE_URL=postgres://... node scripts/production-health-check.mjs
 *   hoặc
 *   node scripts/production-health-check.mjs        # đọc từ .env.local
 *
 * Output:
 *   - PASS:   yêu cầu / cột / index đều tồn tại
 *   - WARN:   không tìm thấy nhưng không critical (vd permission seed optional)
 *   - FAIL:   thiếu cột / bảng / index bắt buộc — KHÔNG deploy được
 *
 * KHÔNG in secret / database URL / stack trace.
 */

import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local" });
config();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Thiếu DATABASE_URL (đặt trong .env.local hoặc biến môi trường).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });

/** Tổng hợp kết quả */
const results = [];
function record(severity, key, label, detail) {
  results.push({ severity, key, label, detail });
}

/* ------------------------------------------------------------------
   CHECKS
   ------------------------------------------------------------------ */

const TABLE_CHECKS = [
  // Bảng nền tảng (luôn phải có)
  { table: "users", required: true },
  { table: "departments", required: true },
  { table: "dw_data", required: true },
  { table: "daily_applications", required: true },
  { table: "form_questions", required: true },
  { table: "field_definitions", required: true },
  { table: "workflow_stages", required: true },
  { table: "rules", required: true },
  { table: "audit_logs", required: true },
  { table: "permissions", required: true },
  { table: "roles", required: true },
  { table: "role_permissions", required: true },
  { table: "user_department_scopes", required: true },
  { table: "notifications", required: true },
  { table: "branding_settings", required: false },
  { table: "dashboard_widgets", required: false },
  { table: "scheduled_jobs", required: false },
  { table: "worker_profiles", required: true },
  { table: "employment_sessions", required: true },
  { table: "start_date_corrections", required: false },
  { table: "workforce_movements", required: true },
  { table: "planning_periods", required: true },
  { table: "planning_targets", required: true },
  { table: "planning_allocations", required: true },
  { table: "planning_column_configs", required: false },
  { table: "planning_tasks", required: false },
  { table: "import_batches", required: false },
  { table: "import_staging_rows", required: false },
  { table: "import_jobs", required: false },
  { table: "import_job_errors", required: false },
  { table: "staging_department", required: false },
  { table: "staging_dw_data", required: false },
  { table: "staging_daily_application", required: false },
  { table: "recruitment_requests", required: true },
  { table: "request_allocations", required: true },
  { table: "request_allocation_history", required: false },
  { table: "request_allocation_overrides", required: false },
  { table: "request_comments", required: false },
  { table: "request_kpi_cache", required: false },
  { table: "merge_templates", required: true },
  { table: "merge_template_fields", required: true },
  { table: "merge_jobs", required: true },
  { table: "merge_job_records", required: true },
];

const COLUMN_CHECKS = [
  // Migration 2026-08-17 thêm
  { table: "recruitment_requests", column: "starting_date", migration: "2026-08-17", required: true },
  { table: "recruitment_requests", column: "end_date", migration: "2026-08-17", required: true },
  { table: "recruitment_requests", column: "offered_vs_requested", migration: "2026-08-17", required: true },
  { table: "recruitment_requests", column: "completed_vs_requested", migration: "2026-08-17", required: true },
  { table: "recruitment_requests", column: "department_id", migration: "2026-08-16-linkage", required: true },
  { table: "recruitment_requests", column: "previous_request_id", migration: "2026-08-17", required: true },
  { table: "recruitment_requests", column: "supersedes_request_id", migration: "2026-08-17", required: true },
  // Migration 2026-08-16-linkage
  { table: "planning_periods", column: "request_id", migration: "2026-08-16-linkage", required: true },
  { table: "daily_applications", column: "request_id", migration: "2026-08-16-linkage", required: true },
  // Migration 2026-08-16-employment-lifecycle
  { table: "employment_sessions", column: "end_reason", migration: "2026-08-16-lifecycle", required: true },
  { table: "employment_sessions", column: "ended_by", migration: "2026-08-16-lifecycle", required: true },
  { table: "employment_sessions", column: "ended_at", migration: "2026-08-16-lifecycle", required: true },
  { table: "employment_sessions", column: "end_movement_id", migration: "2026-08-16-lifecycle", required: true },
  { table: "employment_sessions", column: "start_date_source", migration: "2026-08-16-lifecycle", required: true },
  { table: "workforce_movements", column: "employment_session_id", migration: "2026-08-16-lifecycle", required: true },
  { table: "workforce_movements", column: "confirmed_by", migration: "2026-08-16-lifecycle", required: true },
  { table: "workforce_movements", column: "confirmed_at", migration: "2026-08-16-lifecycle", required: true },
  { table: "workforce_movements", column: "source", migration: "2026-08-16-lifecycle", required: true },
  { table: "daily_applications", column: "worker_declared_previous_resignation", migration: "2026-08-16-lifecycle", required: true },
  { table: "daily_applications", column: "declared_previous_dept_id", migration: "2026-08-16-lifecycle", required: true },
  { table: "daily_applications", column: "declared_resignation_date", migration: "2026-08-16-lifecycle", required: true },
];

const INDEX_CHECKS = [
  { table: "recruitment_requests", index: "recruitment_requests_code_uq", migration: "2026-08-16-recruitment-requests" },
  { table: "recruitment_requests", index: "recruitment_requests_department_id_idx", migration: "2026-08-17" },
  { table: "recruitment_requests", index: "recruitment_requests_expected_date_idx", migration: "2026-08-17" },
  { table: "recruitment_requests", index: "recruitment_requests_end_date_idx", migration: "2026-08-17" },
  { table: "request_allocations", index: "request_alloc_one_active_per_worker_uq", migration: "2026-08-16-linkage" },
  { table: "request_allocations", index: "request_alloc_request_status_idx", migration: "2026-08-16-linkage" },
  { table: "planning_periods", index: "planning_request_idx", migration: "2026-08-16-linkage" },
  { table: "planning_tasks", index: "planning_tasks_open_uq", migration: "2026-08-17" },
  { table: "planning_column_configs", index: "planning_column_configs_uq", migration: "2026-08-17" },
  { table: "planning_allocations", index: "planning_alloc_active_uq", migration: "2026-08-17" },
  { table: "employment_sessions", index: "employment_session_one_active_uq", migration: "2026-08-16-lifecycle (chỉ tạo khi data sạch)" },
  { table: "workforce_movements", index: "workforce_movement_spawn_resignation_uq", migration: "2026-08-12-hardening" },
];

const PERMISSION_CHECKS = [
  { key: "planning.view", seed_required: true },
  { key: "planning.request", seed_required: true },
  { key: "planning.import", seed_required: true },
  { key: "planning.reallocate", seed_required: true },
  { key: "planning.columns.manage", seed_required: true },
  { key: "planning.comment", seed_required: true },
];

async function tableExists(name) {
  const r = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
    [name],
  );
  return r.rowCount > 0;
}

async function columnExists(table, column) {
  const r = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
    [table, column],
  );
  return r.rowCount > 0;
}

async function indexExists(indexName) {
  const r = await client.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [indexName]);
  return r.rowCount > 0;
}

async function getUserCount() {
  const r = await client.query("SELECT count(*)::int AS n FROM users");
  return r.rows[0]?.n ?? 0;
}

async function getRolePermissionCount() {
  const r = await client.query("SELECT count(*)::int AS n FROM role_permissions");
  return r.rows[0]?.n ?? 0;
}

async function getPermissions() {
  const r = await client.query("SELECT key, name FROM permissions ORDER BY key");
  return r.rows.map((x) => x.key);
}

async function getDuplicateActiveEmployment() {
  const r = await client.query(
    "SELECT count(*)::int AS n FROM employment_sessions WHERE status = 'APPROVED' AND end_date IS NULL GROUP BY worker_id HAVING count(*) > 1",
  );
  return r.rowCount;
}

async function getBalanceInconsistency() {
  // Phát hiện bản ghi có balance không khớp công thức cũ hay mới
  const r = await client.query(
    `SELECT count(*)::int AS n
       FROM recruitment_requests
      WHERE deleted_at IS NULL
        AND (
              male_balance <> GREATEST(0, COALESCE(male_rq, 0) - COALESCE(male_recruited, 0))
           OR female_balance <> GREATEST(0, COALESCE(female_rq, 0) - COALESCE(female_recruited, 0))
        )`,
  );
  return r.rows[0]?.n ?? 0;
}

async function getRecruitmentRequestCount() {
  const r = await client.query("SELECT count(*)::int AS n FROM recruitment_requests WHERE deleted_at IS NULL");
  return r.rows[0]?.n ?? 0;
}

async function getDbVersion() {
  const r = await client.query("SELECT current_database() AS db, version() AS v");
  return r.rows[0];
}

async function main() {
  try {
    await client.connect();
  } catch (err) {
    console.error("Không kết nối được tới DB. Kiểm tra DATABASE_URL / mạng / firewall.");
    process.exit(1);
  }

  // 1) DB connection
  try {
    const dbInfo = await getDbVersion();
    record("PASS", "db.connection", "Kết nối database", `database = ${dbInfo.db}`);
  } catch (err) {
    record("FAIL", "db.connection", "Kết nối database", `error = ${err.message}`);
  }

  // 2) Tables
  for (const t of TABLE_CHECKS) {
    try {
      const ok = await tableExists(t.table);
      if (ok) record("PASS", `table.${t.table}`, `Bảng ${t.table} tồn tại`);
      else
        record(
          t.required ? "FAIL" : "WARN",
          `table.${t.table}`,
          `Bảng ${t.table} ${t.required ? "BẮT BUỘC" : "tuỳ chọn"}`,
          t.required ? "CẦN chạy migration tương ứng trước khi deploy" : "Có thể bỏ qua nếu không dùng module",
        );
    } catch (err) {
      record("FAIL", `table.${t.table}`, `Kiểm tra bảng ${t.table}`, err.message);
    }
  }

  // 3) Columns
  for (const c of COLUMN_CHECKS) {
    try {
      const tableOk = await tableExists(c.table);
      if (!tableOk) continue; // đã báo FAIL ở trên
      const ok = await columnExists(c.table, c.column);
      if (ok) record("PASS", `col.${c.table}.${c.column}`, `Cột ${c.table}.${c.column} tồn tại`);
      else
        record(
          c.required ? "FAIL" : "WARN",
          `col.${c.table}.${c.column}`,
          `Cột ${c.table}.${c.column} (migration ${c.migration})`,
          c.required ? "PHẢI chạy migration trước khi deploy" : "Optional",
        );
    } catch (err) {
      record("FAIL", `col.${c.table}.${c.column}`, `Kiểm tra cột ${c.table}.${c.column}`, err.message);
    }
  }

  // 4) Indexes
  for (const idx of INDEX_CHECKS) {
    try {
      const tableOk = await tableExists(idx.table);
      if (!tableOk) continue;
      const ok = await indexExists(idx.index);
      if (ok) record("PASS", `idx.${idx.index}`, `Index ${idx.index} tồn tại`);
      else
        record(
          "FAIL",
          `idx.${idx.index}`,
          `Index ${idx.index} (${idx.migration})`,
          "Thiếu → query chậm, partial unique không hoạt động",
        );
    } catch (err) {
      record("FAIL", `idx.${idx.index}`, `Kiểm tra index ${idx.index}`, err.message);
    }
  }

  // 5) Permissions seed
  try {
    const perms = await getPermissions();
    for (const p of PERMISSION_CHECKS) {
      if (perms.includes(p.key))
        record("PASS", `perm.${p.key}`, `Permission "${p.key}" đã seed`);
      else
        record(
          p.seed_required ? "WARN" : "FAIL",
          `perm.${p.key}`,
          `Permission "${p.key}" chưa seed`,
          "Chạy migration 2026-08-17-planning-recruitment-upgrade.sql (phần 5) hoặc 2026-08-14-dynamic-rbac-v2.sql",
        );
    }
  } catch (err) {
    record("FAIL", "perm.list", "Liệt kê permissions", err.message);
  }

  // 6) Data integrity
  try {
    const dupActive = await getDuplicateActiveEmployment();
    if (dupActive > 0)
      record("FAIL", "integrity.duplicate_active_employment", `${dupActive} nhóm worker có >1 ACTIVE session`, "CẦN chạy scripts/audit-employment-data.mjs và /admin/employment-reconciliation trước khi apply migration 2026-08-16-employment-lifecycle.sql");
    else
      record("PASS", "integrity.duplicate_active_employment", "Không có worker có >1 ACTIVE session");
  } catch (err) {
    record("WARN", "integrity.duplicate_active_employment", "Kiểm tra duplicate active employment", err.message);
  }

  try {
    const balanceBad = await getBalanceInconsistency();
    if (balanceBad > 0)
      record(
        "WARN",
        "integrity.balance_formula",
        `${balanceBad} bản ghi recruitment_requests có balance KHÔNG khớp công thức mới`,
        "Chạy migrations/2026-08-18-balance-recompute.sql SAU khi deploy code mới",
      );
    else
      record("PASS", "integrity.balance_formula", "Balance khớp công thức mới (PHASE 6)");
  } catch (err) {
    record("WARN", "integrity.balance_formula", "Kiểm tra balance formula", err.message);
  }

  // 7) High-level summary
  try {
    const users = await getUserCount();
    const rolePerms = await getRolePermissionCount();
    const recCount = await getRecruitmentRequestCount();
    record(
      "PASS",
      "summary.counts",
      "Số liệu tổng quan",
      `users=${users} role_permissions=${rolePerms} recruitment_requests=${recCount}`,
    );
  } catch (err) {
    record("WARN", "summary.counts", "Số liệu tổng quan", err.message);
  }

  await client.end();
  printReport();
}

function printReport() {
  const passed = results.filter((r) => r.severity === "PASS");
  const warned = results.filter((r) => r.severity === "WARN");
  const failed = results.filter((r) => r.severity === "FAIL");

  console.log("\n=== PRODUCTION HEALTH CHECK ===\n");
  console.log(`PASS: ${passed.length}`);
  console.log(`WARN: ${warned.length}`);
  console.log(`FAIL: ${failed.length}\n`);

  if (failed.length > 0) {
    console.log("--- FAIL ---");
    for (const r of failed) console.log(`  [${r.key}] ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
    console.log("");
  }
  if (warned.length > 0) {
    console.log("--- WARN ---");
    for (const r of warned) console.log(`  [${r.key}] ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
    console.log("");
  }

  if (failed.length > 0) {
    console.log("Kết luận: KHÔNG AN TOÀN để deploy. Chạy các migration còn thiếu trước.");
    process.exit(2);
  } else if (warned.length > 0) {
    console.log("Kết luận: CÓ THỂ deploy, nhưng xem xét các cảnh báo ở trên.");
    process.exit(0);
  } else {
    console.log("Kết luận: Production sẵn sàng.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Lỗi không mong đợi:", err.message);
  process.exit(1);
});
