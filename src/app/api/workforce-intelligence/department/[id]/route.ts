import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { parseOutlookFilters } from "@/lib/workforce-intelligence/filters";
import { getWorkforceIntelligence } from "@/lib/workforce-intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "dashboard.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { id } = await ctx.params;
  const url = new URL(req.url);
  url.searchParams.set("departmentId", id);
  const parsed = parseOutlookFilters(url.searchParams, todayStr());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const outlook = await getWorkforceIntelligence(guard.session, parsed.filters);
    if (outlook.outOfScope) {
      return NextResponse.json({ error: "Bộ phận này nằm ngoài phạm vi dữ liệu bạn có quyền xem." }, { status: 403 });
    }
    const department = outlook.departments[0];
    if (!department) return NextResponse.json({ error: "Không tìm thấy bộ phận." }, { status: 404 });
    return NextResponse.json({ generatedAt: outlook.generatedAt, period: outlook.period, scope: outlook.scope, department });
  } catch (error) {
    console.error("[workforce-intelligence/department]", error);
    return NextResponse.json({ error: "Không thể tải Department Intelligence." }, { status: 500 });
  }
}
