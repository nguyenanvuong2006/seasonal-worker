import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recruitmentRequests } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import {
  listOpenAllocationsForRequest,
  listReallocationTargets,
  reallocateDws,
} from "@/lib/planning-reallocation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ============================================================
   API TÁI PHÂN BỔ DW SANG YÊU CẦU MỚI (Yêu cầu #8, #9, #15)
   ------------------------------------------------------------
   Quyền: ADMIN / HR_RECRUITER + `planning.reallocate`.
   DEPT_MANAGER KHÔNG có quyền này ở cấp DB (allowed = false).

   Data Scope được kiểm tra PHÍA SERVER trong reallocateDws() cho
   CẢ yêu cầu nguồn VÀ yêu cầu đích — không chỉ ẩn trên UI.

   Thao tác này KHÔNG BAO GIỜ tạo Workforce Movement RESIGNATION,
   không ghi quit date, không đặt cờ inactive. DW vẫn đang làm việc.
   ============================================================ */

/**
 * GET /api/planning/reallocate?requestId=...
 * Dữ liệu dựng màn hình chuyển phân bổ: danh sách DW đang gắn với yêu cầu cũ
 * + danh sách yêu cầu đích còn hiệu lực trong cùng Data Scope.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.reallocate");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const requestId = url.searchParams.get("requestId");
  if (!requestId) return NextResponse.json({ error: "Thiếu requestId." }, { status: 400 });

  const scope = await getUserScope(guard.session);

  // Production Recovery audit (PII leak / IDOR) — listOpenAllocationsForRequest() trả
  // fullName+CCCD+gender cho requestId BẤT KỲ, không scope-check. reallocateDws() (POST) đã
  // scope-check nguồn LẪN đích; GET (dựng màn hình) trước đây thì không — 1 tài khoản Data
  // Scope hạn chế có thể xem tên+CCCD lao động thuộc phòng ban ngoài scope chỉ bằng cách biết
  // (hoặc đoán, id lộ qua list response khác) requestId của phòng ban đó.
  const [sourceRequest] = await db
    .select({ departmentId: recruitmentRequests.departmentId })
    .from(recruitmentRequests)
    .where(and(eq(recruitmentRequests.id, requestId), isNull(recruitmentRequests.deletedAt)));
  if (!sourceRequest || !scopeAllowsDepartment(scope, sourceRequest.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });
  }

  const [allocations, targets] = await Promise.all([
    listOpenAllocationsForRequest(requestId),
    listReallocationTargets(scope, { excludeRequestId: requestId }),
  ]);

  return NextResponse.json({
    allocations,
    targets,
    counts: {
      total: allocations.length,
      male: allocations.filter((a) => (a.gender ?? "").toLowerCase().startsWith("n")).length,
    },
  });
}

/**
 * POST /api/planning/reallocate
 * body: { fromRequestId, toRequestId, allocationIds: string[] }
 *
 * Toàn bộ thao tác chạy trong MỘT transaction (xem reallocateDws):
 *   đóng phân bổ cũ (giữ nguyên lịch sử) → tạo phân bổ mới trỏ về bản cũ →
 *   đóng Task tái phân bổ nếu yêu cầu cũ đã hết DW.
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.reallocate");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json().catch(() => ({}))) as {
    fromRequestId?: string;
    toRequestId?: string;
    allocationIds?: string[];
  };

  const scope = await getUserScope(guard.session);
  const result = await reallocateDws({
    fromRequestId: body.fromRequestId ?? "",
    toRequestId: body.toRequestId ?? "",
    allocationIds: [...new Set(body.allocationIds ?? [])],
    actor: guard.session.username,
    scope,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  // Dấu vết kiểm toán: ai chuyển, khi nào, từ yêu cầu nào sang yêu cầu nào.
  await writeAudit(guard.session, "REALLOCATE_DW_TO_REQUEST", "planning_allocations", {
    fromRequestId: body.fromRequestId,
    toRequestId: body.toRequestId,
    moved: result.moved,
    newAllocationIds: result.newAllocationIds,
    taskClosed: result.taskClosed,
    // Ghi rõ trong audit: KHÔNG có ai bị đánh dấu nghỉ việc.
    resignationsCreated: 0,
  });

  return NextResponse.json({
    success: true,
    moved: result.moved,
    newAllocationIds: result.newAllocationIds,
    taskClosed: result.taskClosed,
    message: `Đã chuyển phân bổ ${result.moved} DW sang yêu cầu mới. Không có DW nào bị ghi nhận nghỉ việc.`,
  });
}
