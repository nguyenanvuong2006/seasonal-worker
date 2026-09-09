import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { getProposalById, markCancelled } from "@/lib/ai-copilot/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Hủy" — only the proposer may cancel their own still-PENDING proposal. */
export async function POST(_req: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "ai_copilot.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { proposalId } = await params;
  const row = await getProposalById(proposalId);
  if (!row) return NextResponse.json({ error: "Không tìm thấy đề xuất." }, { status: 404 });
  if (row.createdBy !== guard.session.id) return NextResponse.json({ error: "Chỉ người tạo đề xuất mới có thể hủy." }, { status: 403 });
  if (row.status !== "PENDING") return NextResponse.json({ error: "Đề xuất không còn ở trạng thái chờ xác nhận." }, { status: 409 });

  await markCancelled(row.id, guard.session.id);
  await writeAudit(guard.session, "AI_ACTION_CANCELLED", "ai_copilot_action", { proposalId, action: row.action }, "API");
  return NextResponse.json({ ok: true });
}
