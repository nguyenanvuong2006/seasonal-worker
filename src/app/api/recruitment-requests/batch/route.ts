import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { getUserScope } from "@/lib/auth";
import { batchUpdateStatus, softDeleteRecruitmentRequests } from "@/lib/recruitment-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/recruitment-requests/batch
 * actions: "activate" (-> PROCESSING), "cancel" (-> CANCELLED),
 *          "delete" (xoá mềm), "status" (tuỳ chỉnh)
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    action: string;
    ids: string[];
    status?: string;
  };

  if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
    return NextResponse.json({ error: "Chưa chọn yêu cầu nào." }, { status: 400 });
  }

  if (body.ids.length > 200) {
    return NextResponse.json({ error: "Tối đa 200 yêu cầu mỗi lần thao tác." }, { status: 400 });
  }

  // Data Scope check
  const scope = await getUserScope(guard.session);
  // (Scope filtering is handled in the mutation functions)

  try {
    switch (body.action) {
      case "activate": {
        const count = await batchUpdateStatus(body.ids, "PROCESSING", guard.session.username);
        await writeAudit(guard.session, "BATCH_ACTIVATE_RECRUITMENT_REQUESTS", "recruitment_requests", { ids: body.ids, count });
        return NextResponse.json({ success: true, count });
      }
      case "cancel": {
        const count = await batchUpdateStatus(body.ids, "CANCELLED", guard.session.username);
        await writeAudit(guard.session, "BATCH_CANCEL_RECRUITMENT_REQUESTS", "recruitment_requests", { ids: body.ids, count });
        return NextResponse.json({ success: true, count });
      }
      case "status": {
        if (!body.status) return NextResponse.json({ error: "Thiếu status." }, { status: 400 });
        const valid = ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED"];
        const s = body.status.toUpperCase();
        if (!valid.includes(s)) {
          return NextResponse.json({ error: `Status phải là một trong: ${valid.join(", ")}` }, { status: 400 });
        }
        const count = await batchUpdateStatus(body.ids, s, guard.session.username);
        await writeAudit(guard.session, "BATCH_STATUS_RECRUITMENT_REQUESTS", "recruitment_requests", { ids: body.ids, status: s, count });
        return NextResponse.json({ success: true, count });
      }
      case "delete": {
        const count = await softDeleteRecruitmentRequests(body.ids, guard.session.username);
        await writeAudit(guard.session, "BATCH_DELETE_RECRUITMENT_REQUESTS", "recruitment_requests", { ids: body.ids, count });
        return NextResponse.json({ success: true, count });
      }
      default:
        return NextResponse.json({ error: `Action "${body.action}" không hợp lệ.` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}