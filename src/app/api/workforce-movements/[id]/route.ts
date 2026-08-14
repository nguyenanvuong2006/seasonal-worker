import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { applyMovementAction, type MovementAction } from "@/lib/workforce-movements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** HR xử lý 1 yêu cầu Nghỉ việc/Thuyên chuyển — action nào hợp lệ do lib/workforce-movements.ts kiểm tra. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "workforce_movements.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const body = (await req.json()) as { action?: MovementAction; newEffectiveDate?: string; note?: string };
  if (!body.action) return NextResponse.json({ error: "Thiếu hành động." }, { status: 400 });

  try {
    const { movement, spawnedResignationId } = await applyMovementAction(guard.session, id, body.action, {
      newEffectiveDate: body.newEffectiveDate,
      note: body.note,
    });
    await writeAudit(guard.session, "WORKFORCE_MOVEMENT_" + body.action, "workforce_movements", { id, spawnedResignationId });
    return NextResponse.json({ success: true, movement, spawnedResignationId });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
