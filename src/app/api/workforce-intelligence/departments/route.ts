import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { parseOutlookFilters } from "@/lib/workforce-intelligence/filters";
import { getWorkforceIntelligence } from "@/lib/workforce-intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One aggregate response for the complete in-scope department risk matrix. */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "dashboard.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const parsed = parseOutlookFilters(new URL(req.url).searchParams, todayStr());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const outlook = await getWorkforceIntelligence(guard.session, parsed.filters);
    return NextResponse.json({
      generatedAt: outlook.generatedAt,
      period: outlook.period,
      scope: outlook.scope,
      outOfScope: outlook.outOfScope,
      departments: outlook.departments,
    });
  } catch (error) {
    console.error("[workforce-intelligence/departments]", error);
    return NextResponse.json({ error: "Không thể tải Department Risk Matrix." }, { status: 500 });
  }
}
