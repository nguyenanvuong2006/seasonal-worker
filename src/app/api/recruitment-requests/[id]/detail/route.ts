import { NextResponse } from "next/server";
import { getUserScope, hasPermission, requireAnyPermission } from "@/lib/auth";
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
  // C1 (Mission C) — accepts EITHER canonical view permission (see route.ts's
  // GET list handler for the full rationale); every action below still
  // requires its own specific permission.
  const guard = await requireAnyPermission(["ADMIN", "HR_DIRECTOR", "HR_RECRUITER", "DEPT_MANAGER"], [
    "planning.view",
    "workforce_request.view",
  ]);
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

  const today = todayStr();
  const asOf = asOfParam || resolveDefaultAsOf(row, today);
  const detail = await getRequestDetail(id, asOf);
  if (!detail) return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });

  // Final pre-merge review finding (BLOCKER, fixed pre-merge): the client previously
  // computed "today" itself via `new Date().toISOString().slice(0, 10)` to decide
  // isLive — that's the BROWSER's UTC calendar day, not Vietnam-local. Between
  // 00:00–06:59 ICT every day, todayStr() (server, Vietnam-local) has already rolled
  // to the new day while the client's UTC date string is still yesterday's — a live/
  // open request would then wrongly render as "Cuối kỳ (Closing Workforce)" with a
  // stale frozen-date badge. isLive is now computed HERE (server, same clock/timezone
  // todayStr() itself uses) and handed to the client as data — zero client-side date
  // math, zero timezone drift.
  // C1 (Mission C — Product Consolidation): the canonical page now also
  // hosts the legacy-only actions (allocate, override, comment, Planning
  // link) that used to live only on /admin/workforce-requests. These `can`
  // flags reuse the EXACT SAME permission keys those actions have always
  // required — the canonical page merely surfaces them; it does not widen
  // or narrow who may perform them, and each action route below still
  // re-checks its own permission independently.
  const can = {
    allocate: await hasPermission(guard.session.role, "workforce_request.allocate"),
    overallocate: await hasPermission(guard.session.role, "planning.overallocate"),
    comment: await hasPermission(guard.session.role, "workforce_request.comment"),
    linkPlanning: await hasPermission(guard.session.role, "planning.edit"),
  };

  return NextResponse.json({ ...detail, asOf, isLive: asOf === today, can });
}
