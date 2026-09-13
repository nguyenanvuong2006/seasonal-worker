import { NextResponse } from "next/server";
import { requirePermission, getUserScope, hasPermission } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { normalizePersonName } from "@/lib/person-name";
import { getMealEligibleWorkers, type MealStatusFilter } from "@/lib/meal-list";
import { maskCccd, maskPhone } from "@/lib/daily-intake-workflow";
import { parseOperationalDateRange } from "@/lib/date-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MEAL_STAFF — danh sách đủ điều kiện Báo cơm (mục IX), mặc định hôm nay.
 * Hỗ trợ from/to (range) + deptId + q (tìm theo tên/mã công nhật/CCCD) +
 * status (ELIGIBLE mặc định | INELIGIBLE | ALL) — CÙNG bộ filter với GET
 * /api/meal/export để danh sách hiển thị và file xuất luôn khớp nhau.
 * Legacy `date=` vẫn được hỗ trợ (from=to=date) — GLOBAL DATE RANGE
 * STANDARDIZATION.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "MEAL_STAFF"], "meal.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const rangeResult = parseOperationalDateRange(url.searchParams);
  if (!rangeResult.ok) return NextResponse.json({ error: rangeResult.error.code, message: rangeResult.error.message }, { status: 400 });
  const { range } = rangeResult;
  const deptId = url.searchParams.get("deptId") || null;
  const q = url.searchParams.get("q") || null;
  const status = (url.searchParams.get("status") as MealStatusFilter | null) || "ELIGIBLE";
  const scope = await getUserScope(guard.session);
  if (deptId && !scopeAllowsDepartment(scope, deptId)) {
    return NextResponse.json({ error: "Ngoài phạm vi dữ liệu được cấp." }, { status: 403 });
  }
  const canViewCccd = await hasPermission(guard.session.role, "privacy.view_cccd");
  const canViewPhone = await hasPermission(guard.session.role, "privacy.view_phone");

  const rows = await getMealEligibleWorkers(range, scope, { deptId, q, status });
  const masked = rows.map((r) => ({
    ...r,
    fullName: normalizePersonName(r.fullName),
    cccd: maskCccd(r.cccd, canViewCccd) ?? r.cccd,
    phone: maskPhone(r.phone, canViewPhone) ?? r.phone,
  }));

  return NextResponse.json({ rows: masked, from: range.from, to: range.to, total: masked.length });
}
