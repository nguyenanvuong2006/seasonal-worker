import { NextResponse } from "next/server";
import { getUserScope, hasPermission, requirePermission } from "@/lib/auth";
import { getRequestDashboard } from "@/lib/workforce-request";
import { todayStr } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PLANNING DASHBOARD (mục 13) — tổng hợp Total Requested / Current Workforce /
 * Total Recruited / Total Quit / Need To Recruit, tách Nam/Nữ + drill-down.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"],
    "workforce_request.view",
  );
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const asOfParam = url.searchParams.get("asOf");
  const asOf = asOfParam && /^\d{4}-\d{2}-\d{2}$/.test(asOfParam) ? asOfParam : todayStr();

  const scope = await getUserScope(guard.session);
  const dashboard = await getRequestDashboard(scope, asOf);

  const can = {
    allocate: await hasPermission(guard.session.role, "workforce_request.allocate"),
    overallocate: await hasPermission(guard.session.role, "planning.overallocate"),
    comment: await hasPermission(guard.session.role, "workforce_request.comment"),
  };

  return NextResponse.json({ ...dashboard, can });
}
