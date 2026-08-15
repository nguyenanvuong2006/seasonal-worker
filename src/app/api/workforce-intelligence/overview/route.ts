import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { parseOutlookFilters } from "@/lib/workforce-intelligence/filters";
import { getWorkforceIntelligence } from "@/lib/workforce-intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "dashboard.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const parsed = parseOutlookFilters(new URL(req.url).searchParams, todayStr());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json(await getWorkforceIntelligence(guard.session, parsed.filters));
  } catch (error) {
    console.error("[workforce-intelligence/overview]", error);
    return NextResponse.json({ error: "Không thể tạo Workforce Outlook. Vui lòng thử lại." }, { status: 500 });
  }
}
