import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  dailyApplications,
  departments,
  dwData,
  employmentSessions,
  fieldDefinitions,
  formQuestions,
  notifications,
  planningAllocations,
  planningPeriods,
  planningTargets,
  rolePermissions,
  rules,
  userDepartmentScopes,
  workerProfiles,
  workflowStages,
  workforceMovements,
} from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Bounded limit for audit_logs export to prevent V8 heap OOM / payload timeouts (DR Phase 1). */
export const BUSINESS_EXPORT_AUDIT_LOG_LIMIT = 10_000;

export const INCLUDED_BUSINESS_EXPORT_TABLES = [
  "departments",
  "dw_data",
  "daily_applications",
  "form_questions",
  "field_definitions",
  "workflow_stages",
  "rules",
  "worker_profiles",
  "employment_sessions",
  "planning_periods",
  "planning_targets",
  "planning_allocations",
  "workforce_movements",
  "user_department_scopes",
  "role_permissions",
  "notifications",
  "audit_logs",
] as const;

/**
 * BUSINESS DATA EXPORT — "Xuất dữ liệu nghiệp vụ (JSON)".
 *
 * Tải về bản ghi của 17 bảng nghiệp vụ chính dưới dạng file JSON phục vụ tra cứu, đối chiếu,
 * và phân tích offline.
 *
 * LƯU Ý AN TOÀN & GIỚI HẠN KIẾN TRÚC (DR Phase 1):
 * - Đây KHÔNG PHẢI là bản sao lưu toàn bộ cơ sở dữ liệu (Disaster Recovery Backup).
 * - KHÔNG bao gồm bảng tài khoản (`users` — chứa password_hash vì lý do bảo mật), mẫu tài liệu
 *   (`merge_templates`), pool mã vận hành (`dw_codes`), hay các bảng cấu hình hệ thống khác.
 * - KHÔNG có tính năng Restore tự động từ file này.
 * - Nhật ký hệ thống (`audit_logs`) được giới hạn tối đa 10.000 bản ghi mới nhất
 *   (`BUSINESS_EXPORT_AUDIT_LOG_LIMIT`) với thứ tự giảm dần theo thời gian tạo để bảo vệ bộ nhớ.
 * - Khôi phục thảm hoạ yêu cầu sao lưu cấp cơ sở dữ liệu (database-level backup / PITR / logical
 *   pg_dump chuyên dụng), không dựa vào endpoint này.
 */
export async function GET() {
  const guard = await requireRoleAndPermission(["ADMIN"], "backup.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const [
    dept,
    dw,
    apps,
    questions,
    defs,
    wfStages,
    ruleRows,
    profiles,
    sessions,
    periods,
    targets,
    allocations,
    movements,
    scopes,
    permissions,
    notificationRows,
    audit,
  ] = await Promise.all([
    db.select().from(departments),
    db.select().from(dwData),
    db.select().from(dailyApplications),
    db.select().from(formQuestions),
    db.select().from(fieldDefinitions),
    db.select().from(workflowStages),
    db.select().from(rules),
    db.select().from(workerProfiles),
    db.select().from(employmentSessions),
    db.select().from(planningPeriods),
    db.select().from(planningTargets),
    db.select().from(planningAllocations),
    db.select().from(workforceMovements),
    db.select().from(userDepartmentScopes),
    db.select().from(rolePermissions),
    db.select().from(notifications),
    db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(BUSINESS_EXPORT_AUDIT_LOG_LIMIT),
  ]);

  const now = new Date().toISOString();
  const auditLogsExported = audit.length;
  const auditLogsMayBeTruncated = auditLogsExported >= BUSINESS_EXPORT_AUDIT_LOG_LIMIT;

  const payload = {
    exportType: "BUSINESS_DATA_EXPORT",
    isDisasterRecoveryBackup: false,
    generatedAt: now,
    exportedAt: now,
    exportedBy: guard.session.username,
    sourceCommitSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    includedTables: [...INCLUDED_BUSINESS_EXPORT_TABLES],
    excludedPurpose:
      "Dữ liệu xuất phục vụ tra cứu, đối chiếu và phân tích offline; KHÔNG PHẢI là bản sao lưu toàn bộ cơ sở dữ liệu (Disaster Recovery Backup) và không thể dùng để khôi phục toàn vẹn hệ thống.",
    warning:
      "Bản xuất này chỉ bao gồm các bảng nghiệp vụ được chọn, không bao gồm tài khoản (users), mẫu tài liệu, cấu hình hệ thống hay toàn bộ dữ liệu database. Phục hồi thảm hoạ yêu cầu công cụ sao lưu cấp cơ sở dữ liệu (database-level backup / PITR / logical backup tooling).",
    auditLogLimit: BUSINESS_EXPORT_AUDIT_LOG_LIMIT,
    auditLogsExported,
    auditLogsMayBeTruncated,
    tables: {
      departments: dept,
      dw_data: dw,
      daily_applications: apps,
      form_questions: questions,
      field_definitions: defs,
      workflow_stages: wfStages,
      rules: ruleRows,
      worker_profiles: profiles,
      employment_sessions: sessions,
      planning_periods: periods,
      planning_targets: targets,
      planning_allocations: allocations,
      workforce_movements: movements,
      user_department_scopes: scopes,
      role_permissions: permissions,
      notifications: notificationRows,
      audit_logs: audit,
    },
  };

  await writeAudit(guard.session, "EXPORT_DATABASE_BACKUP", "system", {
    exportType: "BUSINESS_DATA_EXPORT",
    departments: dept.length,
    dwData: dw.length,
    dailyApplications: apps.length,
    workerProfiles: profiles.length,
    workforceMovements: movements.length,
    auditLogsExported,
    auditLogLimit: BUSINESS_EXPORT_AUDIT_LOG_LIMIT,
    auditLogsMayBeTruncated,
  });

  return new NextResponse(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="DalatHasfarm-BusinessData-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}

