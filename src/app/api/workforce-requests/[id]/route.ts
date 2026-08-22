import { NextResponse } from "next/server";
import { getUserScope, hasPermission, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { getRequestDetail, linkRequestToPlanningPeriod } from "@/lib/workforce-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Chi tiết Workforce Request + drill-down + history + comments (mục 10). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"],
    "workforce_request.view",
  );
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const detail = await getRequestDetail(id);
  if (!detail) return NextResponse.json({ error: "Không tìm thấy Workforce Request." }, { status: 404 });

  // Data Scope (mục 11): chỉ thấy request thuộc phạm vi được cấp.
  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, detail.request.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy Workforce Request." }, { status: 404 });
  }

  const can = {
    allocate: await hasPermission(guard.session.role, "workforce_request.allocate"),
    overallocate: await hasPermission(guard.session.role, "planning.overallocate"),
    comment: await hasPermission(guard.session.role, "workforce_request.comment"),
    linkPlanning: await hasPermission(guard.session.role, "planning.edit"),
  };

  return NextResponse.json({ ...detail, can });
}

/** Liên kết Workforce Request ↔ Planning Period bằng ID (mục 8). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const body = (await req.json()) as { planningPeriodId?: string };
  if (!body.planningPeriodId) {
    return NextResponse.json({ error: "Thiếu planningPeriodId." }, { status: 400 });
  }

  // Production Recovery audit (IDOR) — GET trên CÙNG resource đã scope-check, PATCH thì không —
  // 1 HR_RECRUITER bị giới hạn Data Scope có thể liên kết Workforce Request của phòng ban khác
  // với 1 Planning Period bất kỳ. Thêm check giống hệt GET.
  const detail = await getRequestDetail(id);
  if (!detail) return NextResponse.json({ error: "Không tìm thấy Workforce Request." }, { status: 404 });
  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, detail.request.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy Workforce Request." }, { status: 404 });
  }

  try {
    await linkRequestToPlanningPeriod(id, body.planningPeriodId, guard.session.username);
    await writeAudit(guard.session, "LINK_REQUEST_TO_PLANNING", "recruitment_requests", {
      requestId: id,
      planningPeriodId: body.planningPeriodId,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
