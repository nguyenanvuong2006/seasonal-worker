import { NextResponse } from "next/server";
import { pool } from "@/db";
import { requireRoleAndPermission } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * HEALTH MONITOR (Giai đoạn 2 #9) — chỉ hiển thị những chỉ số THẬT sự lấy được từ
 * Postgres (Neon) + biến môi trường build của Vercel. Cố tình KHÔNG hiển thị CPU/RAM
 * giả — nền tảng serverless (Vercel) không cấp quyền đọc chỉ số phần cứng của host,
 * hiển thị số giả sẽ gây hiểu lầm. Muốn xem CPU/RAM/uptime thật, dùng dashboard
 * Neon/Vercel (đã có link trực tiếp ở trang /admin/system).
 */
export async function GET() {
  const guard = await requireRoleAndPermission(["ADMIN"], "system.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const client = await pool.connect();
  try {
    const counts = (
      await client.query(`
        SELECT
          (SELECT count(*)::int FROM departments WHERE deleted_at IS NULL) AS departments,
          (SELECT count(*)::int FROM departments WHERE deleted_at IS NOT NULL) AS departments_deleted,
          (SELECT count(*)::int FROM dw_data WHERE deleted_at IS NULL) AS dw_data,
          (SELECT count(*)::int FROM dw_data WHERE deleted_at IS NOT NULL) AS dw_data_deleted,
          (SELECT count(*)::int FROM daily_applications WHERE deleted_at IS NULL) AS daily_applications,
          (SELECT count(*)::int FROM daily_applications WHERE deleted_at IS NOT NULL) AS daily_applications_deleted,
          (SELECT count(*)::int FROM daily_applications WHERE deleted_at IS NULL AND reg_date = CURRENT_DATE) AS daily_applications_today,
          (SELECT count(*)::int FROM users) AS users,
          (SELECT count(*)::int FROM audit_logs) AS audit_logs
      `)
    ).rows[0];

    const size = (
      await client.query(`
        SELECT pg_size_pretty(pg_database_size(current_database())) AS size_pretty,
               pg_database_size(current_database())::bigint AS size_bytes
      `)
    ).rows[0];

    const lastImport = (
      await client.query(
        `SELECT created_at, action FROM audit_logs WHERE action LIKE 'IMPORT%' ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0];
    const lastExport = (
      await client.query(`SELECT created_at FROM audit_logs WHERE action = 'EXPORT_EXCEL' ORDER BY created_at DESC LIMIT 1`)
    ).rows[0];
    const lastLogin = (
      await client.query(`SELECT created_at, username FROM audit_logs WHERE action = 'LOGIN' ORDER BY created_at DESC LIMIT 1`)
    ).rows[0];
    const lastBackup = (
      await client.query(`SELECT created_at, username FROM audit_logs WHERE action = 'EXPORT_DATABASE_BACKUP' ORDER BY created_at DESC LIMIT 1`)
    ).rows[0];

    // #9 bổ sung: Tables/Indexes, Workflow Version, Metadata Version, Notification Queue, Scheduler
    const tablesAndIndexes = (
      await client.query(`
        SELECT
          (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS tables,
          (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public') AS indexes
      `)
    ).rows[0];
    const workflowVersion = (
      await client.query(`SELECT count(*)::int AS stages, max(updated_at) AS last_updated FROM workflow_stages WHERE is_active = true`)
    ).rows[0];
    const metadataVersion = (
      await client.query(`SELECT count(*)::int AS fields, max(updated_at) AS last_updated FROM field_definitions`)
    ).rows[0];
    const notificationQueue = (
      await client.query(`
        SELECT
          (SELECT count(*)::int FROM notifications WHERE status = 'QUEUED') AS queued,
          (SELECT count(*)::int FROM notifications WHERE status = 'SENT') AS sent,
          (SELECT count(*)::int FROM notifications WHERE status = 'FAILED') AS failed
      `)
    ).rows[0];
    const scheduler = await client.query(
      `SELECT job_key, label, is_active, last_run_at, last_status FROM scheduled_jobs ORDER BY job_key`,
    );

    return NextResponse.json({
      counts,
      dbSize: size,
      tablesAndIndexes,
      workflowVersion,
      metadataVersion,
      notificationQueue,
      scheduler: scheduler.rows,
      lastImport: lastImport ?? null,
      lastExport: lastExport ?? null,
      lastLogin: lastLogin ?? null,
      lastBackup: lastBackup ?? null,
      build: {
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        region: process.env.VERCEL_REGION ?? null,
        checkedAt: new Date().toISOString(),
      },
    });
  } finally {
    client.release();
  }
}
