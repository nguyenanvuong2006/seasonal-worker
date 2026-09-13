import { NextResponse } from "next/server";
import { requirePermission, getUserScope, hasPermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { formatDate } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { getDailyCodeRows, type DailyCodeRow, type DailyCodeStatusFilter } from "@/lib/daily-code-list";
import { maskCccd } from "@/lib/daily-intake-workflow";
import { buildDailyOperationsWorkbook, exportFilenameHeaders } from "@/lib/daily-operations-export";
import { formatDateRangeLabel, parseOperationalDateRange, rangeFilenameSuffix } from "@/lib/date-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ADMINISTRATION — "Xuất danh sách nhập mã công nhật" (mục VI). Server
 * enforce điều kiện (DW imported) — KHÔNG export toàn bộ Daily Application
 * rồi để người dùng tự lọc. Nhận CÙNG bộ filter (from/to/deptId/q/status)
 * với GET /api/administration/daily-code qua getDailyCodeRows dùng chung,
 * để file xuất LUÔN khớp danh sách đang hiển thị trên màn hình. Audit mỗi
 * lần export.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "ADMINISTRATION"], "administration.daily_code.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const rangeResult = parseOperationalDateRange(url.searchParams);
  if (!rangeResult.ok) return NextResponse.json({ error: rangeResult.error.code, message: rangeResult.error.message }, { status: 400 });
  const { range } = rangeResult;
  const deptId = url.searchParams.get("deptId") || null;
  const q = url.searchParams.get("q") || null;
  const status = (url.searchParams.get("status") as DailyCodeStatusFilter | null) || "ALL";
  const scope = await getUserScope(guard.session);
  if (deptId && !scopeAllowsDepartment(scope, deptId)) {
    return NextResponse.json({ error: "Ngoài phạm vi dữ liệu được cấp." }, { status: 403 });
  }
  const canViewCccd = await hasPermission(guard.session.role, "privacy.view_cccd");

  const rows = await getDailyCodeRows(range, scope, { deptId, q, status });

  const buffer = await buildDailyOperationsWorkbook<DailyCodeRow>({
    sheetName: "Nhập mã công nhật",
    title: `Danh sách nhập mã công nhật — ${formatDateRangeLabel(range, formatDate)}`,
    columns: [
      { header: "STT", width: 6, value: (_r, i) => i + 1 },
      { header: "Họ và tên", width: 28, value: (r) => normalizePersonName(r.fullName) },
      { header: "CCCD", width: 16, value: (r) => maskCccd(r.cccd, canViewCccd) ?? r.cccd },
      { header: "Bộ phận", width: 26, value: (r) => [r.deptName, r.groupName].filter(Boolean).join(" — ") },
      { header: "Ngày nhận việc", width: 16, value: (r) => r.startingDate ?? "" },
      { header: "Mã số công nhật", width: 18, value: (r) => r.code ?? "" },
    ],
    rows,
  });

  await writeAudit(guard.session, "EXPORT_DAILY_CODE_LIST", "dw_data", {
    from: range.from,
    to: range.to,
    deptId,
    q,
    status,
    rows: rows.length,
    departmentScope: scope,
  }, "EXPORT");

  return new NextResponse(new Uint8Array(buffer), { headers: exportFilenameHeaders("ma-cong-nhat", rangeFilenameSuffix(range)) });
}
