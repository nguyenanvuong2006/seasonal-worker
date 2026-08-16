import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions, workforceMovements } from "@/db/schema";
import { requirePermission, writeAudit } from "@/lib/auth";
import { queueNotification } from "@/lib/notifications";
import { todayStr } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * EMPLOYMENT LIFECYCLE (#8-B) — Recruiter tạo yêu cầu XÁC NHẬN NGHỈ bộ phận cũ
 * (task PREVIOUS_EMPLOYMENT_RESIGNATION_CONFIRMATION_REQUIRED trong Task Center).
 *
 * Kiến trúc Task Center của repo KHÔNG có bảng tasks riêng (query trực tiếp bảng nghiệp vụ) —
 * task này = 1 workforce_movements(resignation, PENDING_HR, source=RECRUITER_REQUEST) bám đúng
 * employment_session ACTIVE. IDEMPOTENT: mỗi session ACTIVE chỉ có 1 yêu cầu PENDING — gọi lại
 * (double-click/retry/cron) trả về yêu cầu cũ, không tạo trùng.
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "employment.assign");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    employmentSessionId?: string;
    declaredResignationDate?: string | null;
    note?: string | null;
  };
  const employmentSessionId = body.employmentSessionId;
  if (!employmentSessionId) {
    return NextResponse.json({ error: "Thiếu employmentSessionId." }, { status: 400 });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          id: employmentSessions.id,
          workerId: employmentSessions.workerId,
          deptId: employmentSessions.deptId,
          status: employmentSessions.status,
          endDate: employmentSessions.endDate,
        })
        .from(employmentSessions)
        .where(eq(employmentSessions.id, employmentSessionId))
        .for("update");
      if (!session) throw new Error("Không tìm thấy Employment Session.");
      if (session.status !== "APPROVED" || session.endDate) {
        throw new Error("Employment Session này không còn ACTIVE — không cần xác nhận nghỉ.");
      }

      // Idempotent: đã có yêu cầu PENDING cho session này → trả về, không tạo trùng.
      const [existing] = await tx
        .select({ id: workforceMovements.id })
        .from(workforceMovements)
        .where(and(
          eq(workforceMovements.movementType, "resignation"),
          eq(workforceMovements.employmentSessionId, session.id),
          eq(workforceMovements.status, "PENDING_HR"),
        ))
        .limit(1);
      if (existing) return { movementId: existing.id, created: false };

      const [created] = await tx
        .insert(workforceMovements)
        .values({
          movementType: "resignation",
          workerId: session.workerId,
          fromDeptId: session.deptId,
          employmentSessionId: session.id,
          effectiveDate: body.declaredResignationDate || todayStr(),
          reason: "PREVIOUS_EMPLOYMENT_RESIGNATION_CONFIRMATION_REQUIRED — lao động đăng ký xin việc mới nhưng còn được ghi nhận đang làm việc; cần xác nhận nghỉ tại bộ phận cũ trước khi xếp việc mới.",
          note: (body.note ?? "").trim() || null,
          status: "PENDING_HR",
          source: "RECRUITER_REQUEST",
          requestedBy: guard.session.username,
        })
        .returning({ id: workforceMovements.id });
      return { movementId: created.id, created: true };
    });

    if (result.created) {
      await writeAudit(guard.session, "REQUEST_RESIGNATION_CONFIRMATION", "workforce_movements", {
        movementId: result.movementId,
        employmentSessionId: body.employmentSessionId,
      });
      await queueNotification({
        event: "PREVIOUS_EMPLOYMENT_RESIGNATION_CONFIRMATION_REQUIRED",
        recipientType: "ROLE",
        recipientRef: "HR_RECRUITER",
        templateKey: "workforce_movement_created",
        payload: { id: result.movementId, movementType: "resignation", requestedBy: guard.session.username },
      });
    }

    return NextResponse.json({ success: true, movementId: result.movementId, created: result.created });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
