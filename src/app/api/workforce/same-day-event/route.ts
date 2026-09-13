import { NextResponse } from "next/server";
import { getUserScope, requirePermission } from "@/lib/auth";
import { applySameDayLifecycleEvent, type SameDayOutcome } from "@/lib/same-day-lifecycle";
import { toVNDateStr } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_OUTCOMES: SameDayOutcome[] = ["NO_SHOW", "DECLINED_AT_START", "STARTED_THEN_LEFT"];

/**
 * MISSION E section 12-14 — "Bộ phận của tôi" same-day non-start / early-leave
 * report. Reuses `employment.resignation.report` (Báo nghỉ trong Data Scope) —
 * the existing DEPT_MANAGER permission already modeling "manager reports an
 * employment-ending event for a worker in their own Data Scope"; this is the
 * same authority surface applied to same-day outcomes, not a new concept, so
 * no catalog change was needed. Server re-validates the worker's CURRENT dept
 * is within the caller's Data Scope (never trusts a client-supplied dept) —
 * `applySameDayLifecycleEvent` itself performs that check against the true
 * active employment session.
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "DEPT_MANAGER"], "employment.resignation.report");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.workerId !== "string" || !body.workerId) {
    return NextResponse.json({ error: "Thiếu workerId." }, { status: 400 });
  }
  if (!VALID_OUTCOMES.includes(body.outcome)) {
    return NextResponse.json({ error: "outcome không hợp lệ." }, { status: 400 });
  }

  const scope = await getUserScope(guard.session);
  const result = await applySameDayLifecycleEvent({
    workerId: body.workerId,
    outcome: body.outcome,
    eventAt: new Date(),
    reason: typeof body.reason === "string" ? body.reason : null,
    session: guard.session,
    scope,
  });

  if (!result.ok) {
    if (result.error === "OUT_OF_SCOPE") return NextResponse.json({ error: "Người tập nghề này ngoài phạm vi Data Scope của bạn." }, { status: 403 });
    return NextResponse.json({ error: "Không tìm thấy phiên làm việc đang hoạt động cho người này." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    alreadyApplied: result.alreadyApplied,
    eventId: result.eventId,
    mealAction: result.mealAction,
    dwCodeReleased: result.dwCodeReleased,
    itCodeReleased: result.itCodeReleased,
    reportedDate: toVNDateStr(new Date()),
  });
}
