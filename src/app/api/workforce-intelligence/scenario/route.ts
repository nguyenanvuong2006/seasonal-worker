import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { parseOutlookFilters, parseScenarioOverrides } from "@/lib/workforce-intelligence/filters";
import { getWorkforceIntelligence, WorkforceScopeError } from "@/lib/workforce-intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only, in-memory what-if simulation. It never writes business data. */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "dashboard.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON không hợp lệ." }, { status: 400 });
  }
  const params = new URLSearchParams();
  if (typeof body.from === "string") params.set("from", body.from);
  if (typeof body.to === "string") params.set("to", body.to);
  const scenario = parseScenarioOverrides(body.overrides);
  if (!scenario.ok) return NextResponse.json({ error: scenario.error }, { status: 400 });
  params.set("departmentId", scenario.overrides.targetDepartmentId);
  const filters = parseOutlookFilters(params, todayStr());
  if (!filters.ok) return NextResponse.json({ error: filters.error }, { status: 400 });
  try {
    // Strictly read-only: no business write and no audit-table write. The response itself is
    // explicitly labelled SIMULATION/ESTIMATED by the analytics service.
    const outlook = await getWorkforceIntelligence(guard.session, filters.filters, scenario.overrides);
    return NextResponse.json(outlook);
  } catch (error) {
    if (error instanceof WorkforceScopeError) return NextResponse.json({ error: error.message }, { status: 403 });
    console.error("[workforce-intelligence/scenario]", error);
    return NextResponse.json({ error: "Không thể chạy scenario." }, { status: 500 });
  }
}
