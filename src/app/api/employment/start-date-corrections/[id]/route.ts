import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { decideStartDateCorrection, EmploymentRuleError } from "@/lib/employment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * EMPLOYMENT LIFECYCLE (#12) — Admin APPROVE/REJECT yêu cầu điều chỉnh ngày nhận việc.
 * APPROVE chạy transaction an toàn: update starting_date + lưu old/new/approved_by/approved_at
 * — audit trail không mất giá trị cũ. REJECT giữ nguyên start date gốc.
 * Người duyệt không được là người tạo yêu cầu (kể cả Admin) — enforce trong decideCorrection().
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN"], "employment.start_date_correction.approve");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const body = (await req.json()) as { decision?: "APPROVE" | "REJECT"; note?: string | null };
  if (body.decision !== "APPROVE" && body.decision !== "REJECT") {
    return NextResponse.json({ error: "decision phải là APPROVE hoặc REJECT." }, { status: 400 });
  }

  try {
    const result = await decideStartDateCorrection({
      correctionId: id,
      decision: body.decision,
      decidedBy: guard.session.username,
      decisionNote: body.note,
    });

    await writeAudit(guard.session, `START_DATE_CORRECTION_${body.decision}`, "start_date_corrections", {
      id: result.id,
      oldStartDate: result.oldStartDate,
      newStartDate: result.newStartDate,
      note: body.note ?? null,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof EmploymentRuleError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
