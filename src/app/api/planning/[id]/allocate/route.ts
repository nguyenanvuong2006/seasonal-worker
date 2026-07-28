import { NextResponse } from "next/server";
import { db } from "@/db";
import { planningAllocations } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Phân bổ danh sách employment_session (lao động UNPLANNED) vào 1 kế hoạch. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "planning.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const body = (await req.json()) as { employmentSessionIds?: string[] };
  if (!body.employmentSessionIds || body.employmentSessionIds.length === 0) {
    return NextResponse.json({ error: "Chưa chọn lao động nào." }, { status: 400 });
  }

  await db
    .insert(planningAllocations)
    .values(body.employmentSessionIds.map((sid) => ({ employmentSessionId: sid, planningPeriodId: id, allocatedBy: guard.session.username })));

  await writeAudit(guard.session, "ALLOCATE_TO_PLANNING", "planning_allocations", { periodId: id, count: body.employmentSessionIds.length });
  return NextResponse.json({ success: true });
}
