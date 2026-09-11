import { NextResponse } from "next/server";
import { getUserScope, requirePermission } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { getRecruitmentRequest } from "@/lib/recruitment-request";
import { getRequestDetail } from "@/lib/workforce-request";
import { resolveDefaultAsOf } from "@/lib/workforce-request-kpi";
import { todayStr } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/recruitment-requests/:id/detail — CANONICAL Request Detail
 * (Phase 2B mục 4.3). Thin wrapper quanh getRequestDetail() dùng chung với
 * /api/workforce-requests/:id — KHÔNG viết lại query/KPI logic ở đây.
 * Permission khớp `/admin/recruitment-requests` (planning.view — GIỐNG hệt
 * route list/[id] hiện có của domain này), KHÔNG mở rộng Data Scope.
 *
 * asOf mặc định: request đang mở (PENDING/PROCESSING) → hôm nay; request đã
 * EXPIRED/COMPLETED/CANCELLED → đóng băng tại resolveDefaultAsOf (approved
 * design mục 4) — Request Detail xem lại sau khi hết hạn KHÔNG trôi theo
 * Current Workforce hôm nay. Query `?asOf=YYYY-MM-DD` cho phép Admin xem
 * tại 1 mốc bất kỳ (override mặc định).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_DIRECTOR", "HR_RECRUITER", "DEPT_MANAGER"], "planning.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const url = new URL(req.url);
  const asOfParam = url.searchParams.get("asOf");

  // Truy vấn RIÊNG bản ghi request (rẻ, 1 dòng) để biết department_id (Data Scope) +
  // status/endDate (asOf mặc định) TRƯỚC khi gọi getRequestDetail() — tránh gọi hàm
  // chính (nhiều query song song) 2 lần cho cùng 1 request.
  const row = await getRecruitmentRequest(id);
  if (!row) return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });

  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, row.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy yêu cầu trong Data Scope được cấp." }, { status: 404 });
  }

  const asOf = asOfParam || resolveDefaultAsOf(row, todayStr());
  const detail = await getRequestDetail(id, asOf);
  if (!detail) return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });

  return NextResponse.json({ ...detail, asOf });
}
