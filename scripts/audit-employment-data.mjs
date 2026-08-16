#!/usr/bin/env node
/**
 * EMPLOYMENT LIFECYCLE (#17) — DATA INTEGRITY AUDIT (report-only).
 * Chạy TRƯỚC khi apply migrations/2026-08-16-employment-lifecycle.sql lên production.
 * KHÔNG sửa bất kỳ dữ liệu nào — chỉ in báo cáo để Admin đối soát bằng
 * /admin/employment-reconciliation.
 *
 * Cách chạy:  DATABASE_URL=postgres://... node scripts/audit-employment-data.mjs
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

const CHECKS = [
  {
    key: "duplicate_active_employment",
    label: "1 worker có >1 ACTIVE employment session (vi phạm invariant chính)",
    sql: `SELECT wp.cccd, wp.full_name, count(*)::int AS active_sessions,
                 array_agg(es.id ORDER BY es.reg_date DESC) AS session_ids
          FROM employment_sessions es
          JOIN worker_profiles wp ON wp.id = es.worker_id
          WHERE es.status = 'APPROVED' AND es.end_date IS NULL
          GROUP BY wp.cccd, wp.full_name
          HAVING count(*) > 1
          ORDER BY count(*) DESC`,
  },
  {
    key: "cccd_multi_dept_no_resignation",
    label: "1 CCCD ACTIVE ở nhiều Department nhưng chưa có Resignation",
    sql: `SELECT wp.cccd, wp.full_name,
                 array_agg(DISTINCT d.dept_name) AS departments
          FROM employment_sessions es
          JOIN worker_profiles wp ON wp.id = es.worker_id
          LEFT JOIN departments d ON d.id = es.dept_id
          WHERE es.status = 'APPROVED' AND es.end_date IS NULL
          GROUP BY wp.id, wp.cccd, wp.full_name
          HAVING count(DISTINCT es.dept_id) > 1`,
  },
  {
    key: "approved_app_without_session",
    label: "Daily Application đã xếp việc (APPROVED) nhưng không có Employment Session",
    sql: `SELECT da.cccd, da.full_name, da.reg_date
          FROM daily_applications da
          LEFT JOIN employment_sessions es ON es.daily_application_id = da.id
          WHERE da.status = 'APPROVED' AND da.deleted_at IS NULL AND es.id IS NULL
          ORDER BY da.reg_date DESC`,
  },
  {
    key: "active_session_missing_dept",
    label: "Employment Session ACTIVE nhưng Department missing",
    sql: `SELECT es.id, wp.cccd, wp.full_name, es.reg_date
          FROM employment_sessions es
          JOIN worker_profiles wp ON wp.id = es.worker_id
          WHERE es.status = 'APPROVED' AND es.end_date IS NULL AND es.dept_id IS NULL
          ORDER BY es.reg_date DESC`,
  },
  {
    key: "resignation_but_session_active",
    label: "Resignation đã duyệt nhưng session vẫn ACTIVE",
    sql: `SELECT wm.id AS movement_id, wp.cccd, wp.full_name, wm.effective_date, es.id AS session_id
          FROM workforce_movements wm
          JOIN worker_profiles wp ON wp.id = wm.worker_id
          JOIN employment_sessions es ON es.worker_id = wm.worker_id
            AND es.status = 'APPROVED' AND es.end_date IS NULL
          WHERE wm.movement_type = 'resignation' AND wm.status = 'INACTIVE'
            AND wm.effective_date <= CURRENT_DATE
          ORDER BY wm.effective_date DESC`,
  },
  {
    key: "ended_without_end_date",
    label: "Session ENDED/INACTIVE nhưng không có end_date",
    sql: `SELECT es.id, wp.cccd, wp.full_name, es.status, es.reg_date
          FROM employment_sessions es
          JOIN worker_profiles wp ON wp.id = es.worker_id
          WHERE es.status IN ('ENDED','INACTIVE') AND es.end_date IS NULL
          ORDER BY es.reg_date DESC`,
  },
];

async function main() {
  await client.connect();
  console.log("=".repeat(72));
  console.log("EMPLOYMENT DATA INTEGRITY AUDIT — report-only, không sửa dữ liệu");
  console.log("Thời điểm:", new Date().toISOString());
  console.log("=".repeat(72));

  let totalIssues = 0;
  for (const check of CHECKS) {
    const { rows } = await client.query(check.sql);
    totalIssues += rows.length;
    console.log(`\n[${rows.length === 0 ? "OK " : "!!"}] ${check.label}: ${rows.length} dòng`);
    for (const row of rows.slice(0, 20)) {
      console.log("   ", JSON.stringify(row));
    }
    if (rows.length > 20) console.log(`    ... và ${rows.length - 20} dòng nữa`);
  }

  console.log("\n" + "=".repeat(72));
  if (totalIssues === 0) {
    console.log("KẾT LUẬN: dữ liệu sạch — chạy migration sẽ tạo được unique index");
    console.log("employment_session_one_active_uq (invariant 1 worker = 1 ACTIVE).");
  } else {
    console.log(`KẾT LUẬN: phát hiện ${totalIssues} vấn đề. KHÔNG tự sửa.`);
    console.log("Dùng Admin Reconciliation UI (/admin/employment-reconciliation) để đối soát,");
    console.log("sau đó chạy lại script này rồi mới apply lại migration để tạo unique index.");
  }
  await client.end();
  process.exit(totalIssues === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error("Audit thất bại:", e.message);
  process.exit(1);
});
