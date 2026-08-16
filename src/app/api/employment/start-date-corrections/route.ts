import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions } from "@/db/schema";
import { requirePermission, writeAudit } from "@/lib/auth";
import { queueNotification } from "@/lib/notifications";
import { EmploymentRuleError, listPendingStartDateCorrections, requestStartDateCorrection } from "@/lib/employment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * EMPLOYMENT LIFECYCLE (#11) — Recruiter yêu cầu điều chỉnh ngày nhận việc.
 * KHÔNG update starting_date ngay: tạo START_DATE_CORRECTION_REQUEST
 * (status = PENDING_ADMIN_APPROVAL) chờ Admin duyệt ở Task Center.
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "employment.start_date_correction.request");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    employmentSessionId?: string;
    dailyApplicationId?: string; // thay thế: resolve session từ application liên kết
    requestedStartDate?: string;
    reason?: string;
    note?: string | null;
  };
  if ((!body.employmentSessionId && !body.dailyApplicationId) || !body.requestedStartDate || !body.reason) {
    return NextResponse.json({ error: "Thiếu employmentSessionId/dailyApplicationId / requestedStartDate / reason." }, { status: 400 });
  }

  let employmentSessionId = body.employmentSessionId ?? null;
  if (!employmentSessionId && body.dailyApplicationId) {
    const [linked] = await db
      .select({ id: employmentSessions.id })
      .from(employmentSessions)
      .where(eq(employmentSessions.dailyApplicationId, body.dailyApplicationId))
      .limit(1);
    if (!linked) return NextResponse.json({ error: "Không tìm thấy Employment Session liên kết với hồ sơ này." }, { status: 404 });
    employmentSessionId = linked.id;
  }

  try {
    const result = await requestStartDateCorrection({
      employmentSessionId: employmentSessionId!,
      requestedStartDate: body.requestedStartDate,
      reason: body.reason,
      note: body.note,
      requestedBy: guard.session.username,
    });

    if (!result.alreadyPending) {
      await writeAudit(guard.session, "REQUEST_START_DATE_CORRECTION", "start_date_corrections", {
        id: result.id,
        employmentSessionId,
        requestedStartDate: body.requestedStartDate,
        reason: body.reason,
      });
      await queueNotification({
        event: "START_DATE_CORRECTION_REQUEST",
        recipientType: "ROLE",
        recipientRef: "ADMIN",
        templateKey: "workforce_movement_created",
        payload: { id: result.id, requestedBy: guard.session.username, requestedStartDate: body.requestedStartDate },
      });
    }

    return NextResponse.json({ success: true, id: result.id, alreadyPending: result.alreadyPending });
  } catch (error) {
    if (error instanceof EmploymentRuleError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/** Danh sách yêu cầu điều chỉnh đang chờ (Admin/Task Center). */
export async function GET() {
  const guard = await requirePermission(["ADMIN"], "employment.start_date_correction.approve");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const rows = await listPendingStartDateCorrections();
  return NextResponse.json({ rows });
}
