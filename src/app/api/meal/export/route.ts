import { NextResponse } from "next/server";
import { requirePermission, getUserScope, hasPermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { formatDate } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { getMealEligibleWorkers, type MealEligibleRow, type MealStatusFilter } from "@/lib/meal-list";
import { maskCccd } from "@/lib/daily-intake-workflow";
import { buildDailyOperationsWorkbook, exportFilenameHeaders } from "@/lib/daily-operations-export";
import { formatDateRangeLabel, parseOperationalDateRange, rangeFilenameSuffix } from "@/lib/date-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MEAL_STAFF — "Xuất danh sách báo cơm" (mục IX). Server enforce điều kiện
 * (DW imported AND Mã số công nhật not null) — KHÔNG export toàn bộ Daily
 * Application rồi để người dùng tự lọc. Nhận CÙNG bộ filter
 * (from/to/deptId/q/status) với GET /api/meal qua getMealEligibleWorkers
 * dùng chung, để file xuất LUÔN khớp danh sách đang hiển thị trên màn hình.
 * Dùng chung buildDailyOperationsWorkbook() với export Nhập mã công nhật /
 * IT Code / Vân tay — một cấu hình styling duy nhất cho cả 3 màn. Audit
 * mỗi lần export.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "MEAL_STAFF"], "meal.export");
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

  const rows = await getMealEligibleWorkers(range, scope, { deptId, q, status });

  const buffer = await buildDailyOperationsWorkbook<MealEligibleRow>({
    sheetName: "Báo cơm",
    title: `Danh sách báo cơm — ${formatDateRangeLabel(range, formatDate)}`,
    columns: [
      { header: "STT", width: 6, value: (_r, i) => i + 1 },
      { header: "Mã số công nhật", width: 18, value: (r) => r.code ?? "" },
      { header: "Họ và tên", width: 28, value: (r) => normalizePersonName(r.fullName) },
      { header: "CCCD", width: 16, value: (r) => maskCccd(r.cccd, canViewCccd) ?? r.cccd },
      { header: "Bộ phận", width: 26, value: (r) => [r.deptName, r.groupName].filter(Boolean).join(" — ") },
      { header: "Ngày nhận việc", width: 16, value: (r) => r.startingDate ?? "" },
    ],
    rows,
  });

  await writeAudit(guard.session, "EXPORT_MEAL_LIST", "daily_applications", {
    from: range.from,
    to: range.to,
    deptId,
    q,
    status,
    rows: rows.length,
    departmentScope: scope,
  }, "EXPORT");

  return new NextResponse(new Uint8Array(buffer), { headers: exportFilenameHeaders("bao-com", rangeFilenameSuffix(range)) });
}
