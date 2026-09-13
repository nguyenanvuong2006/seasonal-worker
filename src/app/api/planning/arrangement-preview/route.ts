import { NextResponse } from "next/server";
import { getUserScope, requirePermission } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { getDailyArrangementPreview } from "@/lib/daily-arrangement-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MISSION E section 30-42 — Daily Arrangement decision-support preview (read-only).
 * Same permission as the actual arrangement action (employment.assign) — this
 * only surfaces what would happen, never allocates anything itself.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "employment.assign");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const deptId = url.searchParams.get("deptId");
  if (!deptId) return NextResponse.json({ error: "Thiếu deptId." }, { status: 400 });

  const countParam = Number(url.searchParams.get("count") ?? "0");
  const selectedCount = Number.isFinite(countParam) && countParam > 0 ? Math.floor(countParam) : 0;

  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, deptId)) {
    return NextResponse.json({ error: "Bộ phận ngoài phạm vi dữ liệu được cấp." }, { status: 403 });
  }

  const preview = await getDailyArrangementPreview(scope, deptId, selectedCount);
  return NextResponse.json(preview);
}
