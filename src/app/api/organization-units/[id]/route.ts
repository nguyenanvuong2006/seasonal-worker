import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import {
  countActiveRecruitmentRequests,
  countActiveWorkers,
  countTodayApplications,
  deactivateOrganizationUnit,
  getBreadcrumb,
  getDescendants,
  getUnit,
  OrgTreeError,
  reactivateOrganizationUnit,
  updateOrganizationUnit,
} from "@/lib/organization-units";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Chi tiết 1 node: breadcrumb, số con trực tiếp, số worker/request (qua legacy_department_id). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "departments.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const unit = await getUnit(id);
  if (!unit) return NextResponse.json({ error: "Không tìm thấy đơn vị." }, { status: 404 });

  const [breadcrumb, descendants, activeWorkers, activeRequests, todayApplications] = await Promise.all([
    getBreadcrumb(id),
    getDescendants(id),
    countActiveWorkers(unit),
    countActiveRecruitmentRequests(unit),
    countTodayApplications(unit, todayStr()),
  ]);

  return NextResponse.json({
    unit,
    breadcrumb,
    childCount: descendants.filter((d) => d.parentId === id).length,
    descendantCount: descendants.length - 1, // trừ chính node
    activeWorkers,
    activeRequests,
    todayApplications,
  });
}

/**
 * Sửa metadata (tên/loại/thứ tự) HOẶC đổi trạng thái active — KHÔNG đổi cha
 * (đổi cha dùng POST .../move riêng, vì phải cascade lại path cả subtree).
 * KHÔNG có DELETE — xoá cứng bị chặn hoàn toàn ở PR1 (mục 4, 23 đề bài):
 * chỉ có deactivate, giữ nguyên mọi tham chiếu lịch sử.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "departments.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  try {
    const body = await req.json();
    const actor = { username: guard.session.username };

    if (body.action === "DEACTIVATE") {
      const unit = await deactivateOrganizationUnit({ id, actor });
      await writeAudit(guard.session, "DEACTIVATE_ORGANIZATION_UNIT", "organization_units", { id, name: unit.name });
      return NextResponse.json({ success: true, unit });
    }
    if (body.action === "REACTIVATE") {
      const unit = await reactivateOrganizationUnit({ id, actor });
      await writeAudit(guard.session, "REACTIVATE_ORGANIZATION_UNIT", "organization_units", { id, name: unit.name });
      return NextResponse.json({ success: true, unit });
    }

    const unit = await updateOrganizationUnit({
      id,
      name: body.name !== undefined ? String(body.name) : undefined,
      unitType: body.unitType !== undefined ? String(body.unitType) : undefined,
      sortOrder: body.sortOrder !== undefined && Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : undefined,
      actor,
    });
    await writeAudit(guard.session, "UPDATE_ORGANIZATION_UNIT", "organization_units", { id, name: unit.name });
    return NextResponse.json({ success: true, unit });
  } catch (error) {
    if (error instanceof OrgTreeError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    return NextResponse.json({ error: "Lỗi hệ thống: " + (error as Error).message }, { status: 500 });
  }
}
