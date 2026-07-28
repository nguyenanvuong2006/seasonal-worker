import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, dailyApplications, departments, dwData } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * VERSIONING (mục 2.11 / Giai đoạn 2 #3) — thay vì xây một bảng lịch sử riêng, hệ thống
 * tận dụng bảng audit_logs sẵn có (mỗi lần sửa/tạo/xoá đã ghi kèm before/after — xem các
 * route PATCH của departments / dw_data / daily_applications). Endpoint này chỉ lọc lại
 * audit_logs theo 1 hồ sơ cụ thể để hiển thị "Lịch sử" và cho phép "Khôi phục".
 */

const TABLES = {
  daily_applications: dailyApplications,
  dw_data: dwData,
  departments: departments,
} as const;
type TableKey = keyof typeof TABLES;

export async function GET(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "history.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const targetType = url.searchParams.get("targetType") || "";
  const id = url.searchParams.get("id") || "";
  if (!targetType || !id) return NextResponse.json({ error: "Thiếu targetType hoặc id." }, { status: 400 });

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.targetType, targetType), sql`${auditLogs.details}->>'id' = ${id}`))
    .orderBy(desc(auditLogs.createdAt))
    .limit(50);

  return NextResponse.json({ rows });
}

/** Khôi phục 1 phiên bản cũ: áp lại các giá trị "before" đã lưu trong 1 dòng audit log. */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "history.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as { targetType?: string; id?: string; auditLogId?: string };
  const targetType = body.targetType as TableKey;
  if (!targetType || !(targetType in TABLES) || !body.id || !body.auditLogId) {
    return NextResponse.json({ error: "Thiếu dữ liệu để khôi phục." }, { status: 400 });
  }

  const [log] = await db.select().from(auditLogs).where(eq(auditLogs.id, body.auditLogId));
  const before = (log?.details as { before?: Record<string, unknown> } | null)?.before;
  if (!log || !before || Object.keys(before).length === 0) {
    return NextResponse.json({ error: "Phiên bản này không có dữ liệu để khôi phục." }, { status: 400 });
  }

  const table = TABLES[targetType];
  const patchToApply: Record<string, unknown> = { ...before };
  if (targetType === "daily_applications") patchToApply.updatedAt = new Date();

  const [restored] = await db
    .update(table)
    .set(patchToApply as never)
    .where(eq((table as { id: typeof dailyApplications.id }).id, body.id))
    .returning();

  await writeAudit(guard.session, "RESTORE_VERSION", targetType, {
    id: body.id,
    restoredFrom: body.auditLogId,
    before: null,
    after: before,
  });

  return NextResponse.json({ success: true, row: restored });
}
