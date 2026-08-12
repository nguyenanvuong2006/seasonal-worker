import { NextResponse } from "next/server";
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

/**
 * BACKUP FOUNDATION (#13) — "Export Database" tải toàn bộ dữ liệu nghiệp vụ ra 1 file JSON.
 * KHÔNG bao gồm `users` (chứa password_hash) vì lý do bảo mật — dùng /admin/users để backup
 * danh sách tài khoản riêng nếu cần. CHƯA có nút Restore tự động (đúng phạm vi cho phép của yêu
 * cầu) — muốn khôi phục, đưa file JSON này cho AI/dev viết script import 1 lần, hoặc dùng Neon
 * Branches (snapshot cấp database — vẫn là lựa chọn ĐÚNG cho backup định kỳ thật sự/point-in-time
 * recovery, vì bao gồm cả index/sequence/constraint — file JSON này không thay thế được điều đó).
 *
 * Phase 5 (Production Hardening Audit) — TRƯỚC ĐÂY chỉ export 7 bảng (departments, dw_data,
 * daily_applications, form_questions, field_definitions, workflow_stages, rules) dù tên/UI đã
 * ghi "toàn bộ dữ liệu nghiệp vụ" — không khớp thực tế: thiếu hẳn worker_profiles/
 * employment_sessions (Digital Worker File), planning_*, workforce_movements, data scope,
 * role_permissions, notifications, audit_logs. Nay export ĐẦY ĐỦ các bảng nghiệp vụ (không gồm
 * `users` — vẫn loại trừ vì chứa password_hash) để tên gọi/UI hiện có ("Backup toàn bộ dữ liệu
 * nghiệp vụ") phản ánh đúng những gì thực sự tải về.
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
    db.select().from(auditLogs),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: guard.session.username,
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
    departments: dept.length,
    dwData: dw.length,
    dailyApplications: apps.length,
    workerProfiles: profiles.length,
    workforceMovements: movements.length,
  });

  return new NextResponse(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="DalatHasfarm-Backup-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
