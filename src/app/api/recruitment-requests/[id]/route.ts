import { NextResponse } from "next/server";
import { eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recruitmentRequests } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { getRecruitmentRequest, batchUpdateStatus, softDeleteRecruitmentRequests } from "@/lib/recruitment-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/recruitment-requests/:id
 * action: "update" (sửa chi tiết) | "status" (đổi trạng thái)
 * DELETE: xoá mềm draft
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const existing = await getRecruitmentRequest(id);
  if (!existing) return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });

  // Data Scope check
  const scope = await getUserScope(guard.session);
  if (scope !== null && scope.length > 0) {
    const deptMatches = scope.some((d) => !existing.department || existing.department === d || existing.departmentText === d);
    if (!deptMatches) {
      return NextResponse.json({ error: "Không tìm thấy yêu cầu trong Data Scope được cấp." }, { status: 404 });
    }
  }

  const body = (await req.json()) as { action?: string; status?: string; fields?: Record<string, unknown> };

  if (body.action === "status" && body.status) {
    const valid = ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED"];
    const status = body.status.toUpperCase();
    if (!valid.includes(status)) {
      return NextResponse.json({ error: `Status phải là một trong: ${valid.join(", ")}` }, { status: 400 });
    }
    await batchUpdateStatus([id], status, guard.session.username);
    await writeAudit(guard.session, "UPDATE_RECRUITMENT_REQUEST_STATUS", "recruitment_requests", { id, status });
    return NextResponse.json({ success: true, status });
  }

  if (body.action === "update" && body.fields) {
    const fields = body.fields;
    const patch: Record<string, unknown> = {};
    const stringKeys = ["requester", "position", "jobTitle", "location", "section", "groupName", "division", "department", "reason", "noteForReason", "specialRequirements", "month", "remarks", "to", "rqStatus", "monthRc", "departmentText", "monthReport"] as const;
    const numberKeys = ["maleRq", "femaleRq", "maleApplication", "femaleApplication", "maleInterviewed", "femaleInterviewed", "maleRecruited", "femaleRecruited", "maleQuit", "femaleQuit", "cost", "totalRequest", "recruitedVsExpected", "screened", "interview", "recruit"] as const;
    const dateKeys = ["requestedDate", "expectedDate", "offeredDate", "completedDate"] as const;

    for (const k of stringKeys) {
      if (fields[k] !== undefined) patch[k] = fields[k] ? String(fields[k]) : null;
    }
    for (const k of numberKeys) {
      if (fields[k] !== undefined) patch[k] = Math.max(0, Number(fields[k]) || 0);
    }
    for (const k of dateKeys) {
      if (fields[k] !== undefined) patch[k] = fields[k] ? String(fields[k]) : null;
    }
    if (fields.status) patch.status = String(fields.status).toUpperCase();

    // Recompute balance after update
    const maleRq = patch.maleRq !== undefined ? Number(patch.maleRq) : existing.maleRq;
    const femaleRq = patch.femaleRq !== undefined ? Number(patch.femaleRq) : existing.femaleRq;
    const maleRecruited = patch.maleRecruited !== undefined ? Number(patch.maleRecruited) : existing.maleRecruited;
    const femaleRecruited = patch.femaleRecruited !== undefined ? Number(patch.femaleRecruited) : existing.femaleRecruited;
    const maleQuit = patch.maleQuit !== undefined ? Number(patch.maleQuit) : existing.maleQuit;
    const femaleQuit = patch.femaleQuit !== undefined ? Number(patch.femaleQuit) : existing.femaleQuit;
    patch.maleBalance = Math.max(0, maleRq - maleRecruited + maleQuit);
    patch.femaleBalance = Math.max(0, femaleRq - femaleRecruited + femaleQuit);
    patch.totalBalance = Number(patch.maleBalance) + Number(patch.femaleBalance);

    const [updated] = await db
      .update(recruitmentRequests)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(recruitmentRequests.id, id))
      .returning();

    await writeAudit(guard.session, "UPDATE_RECRUITMENT_REQUEST", "recruitment_requests", { id, requestCode: updated.requestCode });
    return NextResponse.json({ success: true, row: updated });
  }

  return NextResponse.json({ error: "Thiếu action hợp lệ." }, { status: 400 });
}

/** Xoá mềm yêu cầu tuyển dụng. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const existing = await getRecruitmentRequest(id);
  if (!existing) return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });

  const scope = await getUserScope(guard.session);
  if (scope !== null && scope.length > 0) {
    const deptMatches = scope.some((d) => !existing.department || existing.department === d);
    if (!deptMatches) {
      return NextResponse.json({ error: "Không tìm thấy yêu cầu trong Data Scope được cấp." }, { status: 404 });
    }
  }

  await softDeleteRecruitmentRequests([id], guard.session.username);
  await writeAudit(guard.session, "DELETE_RECRUITMENT_REQUEST", "recruitment_requests", { id, requestCode: existing.requestCode });
  return NextResponse.json({ success: true });
}
