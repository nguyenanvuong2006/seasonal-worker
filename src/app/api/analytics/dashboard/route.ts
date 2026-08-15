import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { parseAnalyticsFilters } from "@/lib/analytics-core";
import { getDashboardAnalytics } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/dashboard — 1 endpoint aggregate DUY NHẤT cho toàn bộ
 * Workforce Analytics Dashboard (không để mỗi chart tự gọi 1 endpoint).
 *
 * Query: from, to, location, division, departmentId, section, groupName,
 *        workerType (ALL|NEW|RETURNING), gender (ALL|MALE|FEMALE|OTHER),
 *        referralChannel (hoặc __UNKNOWN__), status (stageKey).
 *
 * Bảo mật:
 *   - requirePermission(..., "dashboard.view") — cùng permission dashboard hiện có.
 *   - Data Scope role-independent qua getUserScope() (áp trong lib/analytics.ts):
 *     null = toàn bộ, [] = không thấy gì, [ids] = chỉ các bộ phận đó. Filter yêu cầu
 *     department ngoài scope → mọi số liệu = 0 (outOfScope=true), không leak aggregate.
 *   - Payload chỉ chứa DỮ LIỆU TỔNG HỢP (không CCCD/SĐT/danh sách tên lao động).
 *   - Không cache theo user (force-dynamic) — tránh trả kết quả Admin cho Manager.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "dashboard.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const parsed = parseAnalyticsFilters(url.searchParams, todayStr());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const data = await getDashboardAnalytics(guard.session, parsed.filters);
    return NextResponse.json(data);
  } catch (error) {
    // Không leak raw error DB ra client.
    console.error("[analytics/dashboard]", error);
    return NextResponse.json({ error: "Không thể tải dữ liệu phân tích. Vui lòng thử lại." }, { status: 500 });
  }
}
