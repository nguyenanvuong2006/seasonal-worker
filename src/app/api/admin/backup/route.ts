import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  dailyApplications,
  departments,
  dwData,
  fieldDefinitions,
  formQuestions,
  rules,
  workflowStages,
} from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * BACKUP FOUNDATION (#13) — "Export Database" tải toàn bộ dữ liệu nghiệp vụ ra
 * 1 file JSON. KHÔNG bao gồm `users` (chứa password_hash) vì lý do bảo mật —
 * dùng /admin/users để backup danh sách tài khoản riêng nếu cần. CHƯA có nút
 * Restore tự động (đúng phạm vi cho phép của yêu cầu) — muốn khôi phục, đưa
 * file JSON này cho AI/dev viết script import 1 lần, hoặc dùng Neon Branches
 * (snapshot cấp database, khuyến nghị cho backup định kỳ thật sự).
 */
export async function GET() {
  const guard = await requireRoleAndPermission(["ADMIN"], "backup.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const [dept, dw, apps, questions, defs, wfStages, ruleRows] = await Promise.all([
    db.select().from(departments),
    db.select().from(dwData),
    db.select().from(dailyApplications),
    db.select().from(formQuestions),
    db.select().from(fieldDefinitions),
    db.select().from(workflowStages),
    db.select().from(rules),
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
    },
  };

  await writeAudit(guard.session, "EXPORT_DATABASE_BACKUP", "system", {
    departments: dept.length,
    dwData: dw.length,
    dailyApplications: apps.length,
  });

  return new NextResponse(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="DalatHasfarm-Backup-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
