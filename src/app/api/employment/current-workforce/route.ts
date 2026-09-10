import { NextResponse } from "next/server";
import { getUserScope, requirePermission } from "@/lib/auth";
import { getDepartmentWorkforceRoster, type RosterFilter } from "@/lib/workforce-roster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_FILTERS: RosterFilter[] = ["ACTIVE", "UPCOMING_RESIGNATION", "UPCOMING_TRANSFER", "RESIGNED", "TRANSFERRED", "ALL"];

/**
 * CANONICAL current-department-workforce roster (Worker Lifecycle Consistency audit,
 * 2026-09-10) — "Bộ phận của tôi" (department/page.tsx) reads from here now instead of
 * daily_applications, so it agrees with countActiveDepartmentWorkforce()/get_current_headcount
 * and every other "current workforce" consumer. Same permission as the page's previous data
 * source (registrations.view) — this replaces, not adds to, that screen's read surface.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR", "HR_SUPPORT"], "registrations.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const filterParam = url.searchParams.get("filter") ?? "ACTIVE";
  const filter = VALID_FILTERS.includes(filterParam as RosterFilter) ? (filterParam as RosterFilter) : "ACTIVE";
  const deptId = url.searchParams.get("deptId") || undefined;

  const scope = await getUserScope(guard.session);
  const rows = await getDepartmentWorkforceRoster(scope, filter, deptId);
  return NextResponse.json({ rows, filter });
}
