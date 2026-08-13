import { NextResponse } from "next/server";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { activatePeriod, reviseActivePeriod } from "@/lib/planning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** action: "activate" (Draft -> Active) | "revise" (Active -> version mới, giữ lịch sử bản cũ). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "planning.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const body = (await req.json()) as {
    action?: "activate" | "revise";
    startDate?: string;
    endDate?: string;
    demandMale?: number;
    demandFemale?: number;
    targetCount?: number;
    note?: string;
  };

  try {
    if (body.action === "activate") {
      const row = await activatePeriod(id);
      await writeAudit(guard.session, "ACTIVATE_PLANNING_PERIOD", "planning_periods", { id });
      return NextResponse.json({ success: true, row });
    }
    if (body.action === "revise") {
      const row = await reviseActivePeriod(
        id,
        {
          startDate: body.startDate,
          endDate: body.endDate,
          demandMale: body.demandMale,
          demandFemale: body.demandFemale,
          targetCount: body.targetCount,
          note: body.note,
        },
        guard.session.username,
      );
      await writeAudit(guard.session, "REVISE_PLANNING_PERIOD", "planning_periods", { id, newVersionId: row.id });
      return NextResponse.json({ success: true, row });
    }
    return NextResponse.json({ error: "Thiếu action hợp lệ." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
