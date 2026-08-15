import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions, planningAllocations, planningPeriods } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Phân bổ danh sách employment_session (lao động UNPLANNED) vào 1 kế hoạch. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const body = (await req.json()) as { employmentSessionIds?: string[] };
  const sessionIds = [...new Set(body.employmentSessionIds ?? [])];
  if (sessionIds.length === 0) return NextResponse.json({ error: "Chưa chọn lao động nào." }, { status: 400 });
  if (sessionIds.length > 500) return NextResponse.json({ error: "Tối đa 500 lao động mỗi lần phân bổ." }, { status: 400 });

  const [period] = await db
    .select({ departmentId: planningPeriods.departmentId, status: planningPeriods.status })
    .from(planningPeriods)
    .where(eq(planningPeriods.id, id));
  if (!period) return NextResponse.json({ error: "Không tìm thấy kế hoạch." }, { status: 404 });
  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, period.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy kế hoạch trong Data Scope được cấp." }, { status: 404 });
  }
  if (period.status !== "ACTIVE") return NextResponse.json({ error: "Chỉ phân bổ vào kế hoạch ACTIVE." }, { status: 400 });

  const sessions = await db
    .select({ id: employmentSessions.id, deptId: employmentSessions.deptId })
    .from(employmentSessions)
    .where(and(
      inArray(employmentSessions.id, sessionIds),
      eq(employmentSessions.status, "APPROVED"),
      isNull(employmentSessions.endDate),
    ));
  if (sessions.length !== sessionIds.length || sessions.some((session) => session.deptId !== period.departmentId)) {
    return NextResponse.json({ error: "Có Employment Session không active hoặc không thuộc đúng bộ phận của kế hoạch." }, { status: 400 });
  }

  await db
    .insert(planningAllocations)
    .values(sessionIds.map((sid) => ({ employmentSessionId: sid, planningPeriodId: id, allocatedBy: guard.session.username })))
    .onConflictDoNothing();

  await writeAudit(guard.session, "ALLOCATE_TO_PLANNING", "planning_allocations", { periodId: id, count: sessionIds.length });
  return NextResponse.json({ success: true });
}
