import { NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, startDateCorrections, workerProfiles } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { getEmploymentContextByCccd } from "@/lib/employment";
import { classifyEmploymentBadge } from "@/lib/employment-lifecycle";
import { CCCD_ERROR_MESSAGE, isValidCccd, normalizeCccd } from "@/lib/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * EMPLOYMENT LIFECYCLE (#7, #14) — bối cảnh employment của 1 ứng viên cho màn hình Xếp việc:
 *   - Session ACTIVE hiện tại (warning "đang làm việc tại...").
 *   - Self-declaration của application (nếu có) — "khai đã báo nghỉ ngày X, chưa xác nhận".
 *   - Toàn bộ lịch sử đã kết thúc (warning history "đã từng làm tại Dalat Hasfarm").
 *   - Badge phân loại: MỚI / ĐANG LÀM / ĐÃ TỪNG LÀM / CHỜ XÁC NHẬN NGHỈ / CẦN ĐỐI SOÁT.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "employment.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const rawCccd = url.searchParams.get("cccd") ?? "";
  if (!isValidCccd(rawCccd)) return NextResponse.json({ error: CCCD_ERROR_MESSAGE }, { status: 400 });
  const cccd = normalizeCccd(rawCccd);

  const context = await getEmploymentContextByCccd(cccd);

  // Self-declaration mới nhất chưa xác minh (application còn PENDING/WAITLIST).
  const [declaration] = context.workerId
    ? await db
        .select({
          applicationId: dailyApplications.id,
          regDate: dailyApplications.regDate,
          declaredResignationDate: dailyApplications.declaredResignationDate,
          declaredResignationNote: dailyApplications.declaredResignationNote,
          declaredAt: dailyApplications.declaredAt,
        })
        .from(dailyApplications)
        .innerJoin(workerProfiles, and(eq(dailyApplications.cccd, workerProfiles.cccd), isNull(workerProfiles.deletedAt)))
        .where(and(
          eq(workerProfiles.id, context.workerId),
          eq(dailyApplications.workerDeclaredPreviousResignation, true),
          isNull(dailyApplications.deletedAt),
        ))
        .orderBy(desc(dailyApplications.regDate))
        .limit(1)
    : [];

  const pendingCorrections = context.workerId
    ? await db
        .select({ id: startDateCorrections.id, requestedStartDate: startDateCorrections.requestedStartDate, status: startDateCorrections.status })
        .from(startDateCorrections)
        .where(and(eq(startDateCorrections.workerId, context.workerId), eq(startDateCorrections.status, "PENDING_ADMIN_APPROVAL")))
    : [];

  const badge = classifyEmploymentBadge({
    hasActiveSession: Boolean(context.activeSession),
    pastEndedSessions: context.endedSessions.length,
    hasPendingResignationConfirmation: context.pendingResignations.length > 0,
    hasDuplicateActive: context.duplicateActive,
  });

  return NextResponse.json({
    workerId: context.workerId,
    badge,
    activeSession: context.activeSession,
    endedSessions: context.endedSessions,
    pendingResignations: context.pendingResignations,
    duplicateActive: context.duplicateActive,
    selfDeclaration: declaration ?? null,
    pendingStartDateCorrections: pendingCorrections,
  });
}
