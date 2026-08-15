import { NextResponse } from "next/server";
import { getUserScope, requirePermission } from "@/lib/auth";
import { getUnplannedSessions } from "@/lib/planning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lao động ĐANG LÀM nhưng chưa được phân bổ vào kế hoạch ACTIVE nào — dùng khi tạo kế hoạch mới. */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const departmentId = new URL(req.url).searchParams.get("departmentId") || null;
  const scope = await getUserScope(guard.session);
  if (scope !== null && departmentId && !scope.includes(departmentId)) {
    return NextResponse.json({ rows: [] });
  }
  const departmentIds = departmentId ? [departmentId] : scope === null ? undefined : scope;
  const rows = await getUnplannedSessions(departmentIds);
  return NextResponse.json({ rows });
}
