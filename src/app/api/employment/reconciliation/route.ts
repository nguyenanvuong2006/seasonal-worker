import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions, workforceMovements } from "@/db/schema";
import { requirePermission, writeAudit } from "@/lib/auth";
import { auditEmploymentIntegrity, EmploymentRuleError } from "@/lib/employment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * EMPLOYMENT LIFECYCLE (#17-18) — ADMIN DATA RECONCILIATION.
 * GET  = báo cáo dữ liệu bẩn (report-only, không sửa gì).
 * POST = Admin chọn hành động đối soát cho TỪNG session — không bao giờ DELETE lịch sử:
 *   CLOSE_SESSION      — đóng 1 session sai/duplicate (ENDED + end_reason=RECONCILIATION + ngày nghỉ xác nhận)
 *   SET_START_DATE     — sửa ngày nhận việc (start_date_source=RECONCILIATION, audit giữ giá trị cũ)
 *   LINK_APPLICATION   — liên kết session với daily_application gốc
 * Mọi hành động ghi audit log trước khi trả về.
 */
export async function GET() {
  const guard = await requirePermission(["ADMIN"], "employment.reconcile");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const report = await auditEmploymentIntegrity();
  return NextResponse.json(report);
}

export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN"], "employment.reconcile");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    action?: "CLOSE_SESSION" | "SET_START_DATE" | "LINK_APPLICATION";
    sessionId?: string;
    endDate?: string;
    startDate?: string;
    dailyApplicationId?: string;
    note?: string | null;
  };
  if (!body.action || !body.sessionId) {
    return NextResponse.json({ error: "Thiếu action / sessionId." }, { status: 400 });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(employmentSessions)
        .where(eq(employmentSessions.id, body.sessionId!))
        .for("update");
      if (!session) throw new EmploymentRuleError("Không tìm thấy Employment Session.", "SESSION_NOT_FOUND");

      switch (body.action) {
        case "CLOSE_SESSION": {
          if (!body.endDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate)) {
            throw new EmploymentRuleError("Cần nhập ngày nghỉ (endDate, YYYY-MM-DD) khi đóng session.", "INVALID_DATE");
          }
          if (session.endDate) {
            // Idempotent — đã đóng rồi thì không đóng lại/không đổi lịch sử.
            return { before: session, after: session, changed: false };
          }
          const now = new Date();
          // Movement RECONCILIATION để lịch sử giải thích được vì sao session đóng.
          const [movement] = await tx
            .insert(workforceMovements)
            .values({
              movementType: "resignation",
              workerId: session.workerId,
              fromDeptId: session.deptId,
              employmentSessionId: session.id,
              effectiveDate: body.endDate,
              reason: "Đối soát dữ liệu (Admin Reconciliation)",
              note: (body.note ?? "").trim() || null,
              status: "INACTIVE",
              source: "RECONCILIATION",
              requestedBy: guard.session.username,
              confirmedBy: guard.session.username,
              confirmedAt: now,
            })
            .returning({ id: workforceMovements.id });
          const [after] = await tx
            .update(employmentSessions)
            .set({
              status: "ENDED",
              endDate: body.endDate,
              endReason: "RECONCILIATION",
              endedBy: guard.session.username,
              endedAt: now,
              endMovementId: movement.id,
            })
            .where(eq(employmentSessions.id, session.id))
            .returning();
          return { before: session, after, changed: true };
        }
        case "SET_START_DATE": {
          if (!body.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
            throw new EmploymentRuleError("Cần nhập ngày nhận việc (startDate, YYYY-MM-DD).", "INVALID_DATE");
          }
          const [after] = await tx
            .update(employmentSessions)
            .set({ startingDate: body.startDate, startDateSource: "RECONCILIATION" })
            .where(eq(employmentSessions.id, session.id))
            .returning();
          return { before: session, after, changed: session.startingDate !== body.startDate };
        }
        case "LINK_APPLICATION": {
          if (!body.dailyApplicationId) {
            throw new EmploymentRuleError("Thiếu dailyApplicationId.", "INVALID_INPUT");
          }
          // unique index employment_session_daily_app_uq bảo vệ 1 application ↔ 1 session.
          const [conflict] = await tx
            .select({ id: employmentSessions.id })
            .from(employmentSessions)
            .where(and(eq(employmentSessions.dailyApplicationId, body.dailyApplicationId), isNull(employmentSessions.endDate)))
            .limit(1);
          if (conflict && conflict.id !== session.id) {
            throw new EmploymentRuleError("Daily Application này đã liên kết với 1 Employment Session khác.", "APPLICATION_ALREADY_LINKED");
          }
          const [after] = await tx
            .update(employmentSessions)
            .set({ dailyApplicationId: body.dailyApplicationId })
            .where(eq(employmentSessions.id, session.id))
            .returning();
          return { before: session, after, changed: true };
        }
        default:
          throw new EmploymentRuleError("Hành động không hợp lệ.", "INVALID_ACTION");
      }
    });

    await writeAudit(guard.session, `EMPLOYMENT_RECONCILE_${body.action}`, "employment_sessions", {
      sessionId: body.sessionId,
      before: { status: result.before.status, endDate: result.before.endDate, startingDate: result.before.startingDate, dailyApplicationId: result.before.dailyApplicationId },
      after: { status: result.after.status, endDate: result.after.endDate, startingDate: result.after.startingDate, dailyApplicationId: result.after.dailyApplicationId },
      note: body.note ?? null,
    });

    return NextResponse.json({ success: true, changed: result.changed, session: result.after });
  } catch (error) {
    if (error instanceof EmploymentRuleError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    if ((error as { code?: string; constraint?: string }).code === "23505") {
      return NextResponse.json({ error: "Xung đột dữ liệu (unique constraint) — tải lại báo cáo và thử lại.", }, { status: 409 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
