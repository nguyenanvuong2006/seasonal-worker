import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { allocateWorkersToRequest } from "@/lib/workforce-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ALLOCATE / RE-ALLOCATE worker vào Workforce Request (mục 4, 5, 6, 12).
 * - Chặn khi tổng phân bổ vượt Total Request trừ khi có quyền
 *   planning.overallocate + override {confirmed, reason} (mục 6).
 * - Chuyển request: kết thúc allocation cũ + tạo mới, KHÔNG tạo Resignation.
 * - Double-click/retry: idempotent (NOOP / onConflict partial unique index).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "workforce_request.allocate");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const body = (await req.json()) as {
    employmentSessionIds?: string[];
    reason?: string | null;
    override?: { confirmed: boolean; reason: string } | null;
  };

  const sessionIds = [...new Set(body.employmentSessionIds ?? [])];
  if (sessionIds.length === 0) {
    return NextResponse.json({ error: "Chưa chọn lao động nào." }, { status: 400 });
  }

  try {
    const outcome = await allocateWorkersToRequest({
      session: guard.session,
      requestId: id,
      employmentSessionIds: sessionIds,
      reason: body.reason ?? null,
      override: body.override ?? null,
    });
    return NextResponse.json({ success: true, ...outcome });
  } catch (error) {
    const err = error as Error & { code?: string };
    const status = err.code === "TOTAL_OVER_TARGET" ? 409 : err.code === "FORBIDDEN" ? 403 : err.code === "NOT_FOUND" ? 404 : 400;
    return NextResponse.json({ error: err.message, code: err.code ?? "INVALID" }, { status });
  }
}
