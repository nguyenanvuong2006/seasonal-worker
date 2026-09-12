import { NextResponse } from "next/server";
import { getUserScope, requireAnyPermission } from "@/lib/auth";
import { getRecruitmentManagementDashboard } from "@/lib/workforce-request";
import { todayStr } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/recruitment-requests/dashboard — MANAGEMENT DASHBOARD (Mission C — C3).
 * Thin wrapper around getRecruitmentManagementDashboard() — no computation
 * here, no direct DB queries. Reuses the SAME two canonical view permissions
 * as every other canonical Recruitment Requests route (see
 * ../route.ts's GET list handler for the full requireAnyPermission
 * rationale) rather than introducing a new permission key. Data Scope is
 * server-resolved from the session (getUserScope) and passed straight
 * through — never trusted from the client.
 */
export async function GET(req: Request) {
  const guard = await requireAnyPermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], [
    "planning.view",
    "workforce_request.view",
  ]);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const url = new URL(req.url);
    const asOfParam = url.searchParams.get("asOf");
    const asOf = asOfParam && /^\d{4}-\d{2}-\d{2}$/.test(asOfParam) ? asOfParam : todayStr();

    const scope = await getUserScope(guard.session);
    const dashboard = await getRecruitmentManagementDashboard(scope, asOf);

    return NextResponse.json(dashboard);
  } catch (error) {
    console.error("[recruitment-requests/dashboard] GET failed", error);
    return NextResponse.json(
      { error: "Không thể tải Dashboard quản lý tuyển dụng. Vui lòng thử lại." },
      { status: 500 },
    );
  }
}
