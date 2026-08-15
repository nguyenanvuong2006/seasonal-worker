import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workforceMovements } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { movementScopeVisibility } from "@/lib/data-scope";
import { applyMovementAction, type MovementAction } from "@/lib/workforce-movements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** HR xử lý 1 yêu cầu Nghỉ việc/Thuyên chuyển — action hợp lệ do service kiểm tra. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "workforce_movements.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { id } = await ctx.params;
  const body = (await req.json()) as { action?: MovementAction; newEffectiveDate?: string; note?: string };
  if (!body.action) return NextResponse.json({ error: "Thiếu hành động." }, { status: 400 });

  const [existing] = await db
    .select({ movementType: workforceMovements.movementType, fromDeptId: workforceMovements.fromDeptId, toDeptId: workforceMovements.toDeptId })
    .from(workforceMovements)
    .where(eq(workforceMovements.id, id));
  if (!existing) return NextResponse.json({ error: "Không tìm thấy yêu cầu." }, { status: 404 });
  const scope = await getUserScope(guard.session);
  const visibility = movementScopeVisibility(scope, existing.movementType, existing.fromDeptId, existing.toDeptId);
  if (visibility === "NONE") return NextResponse.json({ error: "Không tìm thấy yêu cầu trong Data Scope được cấp." }, { status: 404 });
  if (visibility === "REDACTED_INCOMING" && !(["CONFIRM_ARRIVED", "RESCHEDULE", "NOT_ARRIVED"] as MovementAction[]).includes(body.action)) {
    return NextResponse.json({ error: "Hành động này yêu cầu quyền trên bộ phận nguồn." }, { status: 403 });
  }

  try {
    const { movement, spawnedResignationId } = await applyMovementAction(guard.session, id, body.action, {
      newEffectiveDate: body.newEffectiveDate,
      note: body.note,
    });
    await writeAudit(guard.session, "WORKFORCE_MOVEMENT_" + body.action, "workforce_movements", { id, spawnedResignationId });
    const safeMovement = visibility === "REDACTED_INCOMING"
      ? { ...movement, reason: null, note: null, requestedBy: null, relatedMovementId: null }
      : movement;
    return NextResponse.json({ success: true, movement: safeMovement, spawnedResignationId: visibility === "FULL" ? spawnedResignationId : null });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
