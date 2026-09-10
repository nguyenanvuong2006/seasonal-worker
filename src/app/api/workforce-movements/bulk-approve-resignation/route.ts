import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { workforceMovements } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { movementScopeVisibility } from "@/lib/data-scope";
import { applyMovementAction } from "@/lib/workforce-movements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BATCH_SIZE = 100;

type BulkOutcome = "APPROVED" | "ALREADY_APPROVED" | "NO_LONGER_ELIGIBLE" | "OUT_OF_SCOPE" | "FAILED";

/**
 * Duyệt nghỉ việc HÀNG LOẠT — HR chọn nhiều yêu cầu "Chờ HR duyệt" rồi duyệt 1 lần thay vì
 * lặp lại thao tác "Duyệt nghỉ việc" (nút đơn lẻ) từng dòng. KHÔNG tái tạo nghiệp vụ nghỉ
 * việc ở đây: mỗi id được xử lý ĐỘC LẬP qua applyMovementAction(..., "APPROVE_RESIGNATION")
 * — chính xác service duy nhất mà route đơn lẻ (PATCH /api/workforce-movements/[id]) dùng,
 * gồm cả row lock (`for("update")`), kiểm tra lại trạng thái (isActionAllowed), đóng đúng
 * employment session, dọn request allocation, recompute KPI, và notification. Route này chỉ
 * lặp qua danh sách id và ghi audit từng bản ghi thành công — không có state machine/transition
 * thứ hai nào.
 *
 * Partial success: 1 id lỗi/không còn hợp lệ/ngoài Data Scope KHÔNG làm hỏng cả lô — mỗi id
 * có kết quả riêng, xử lý tuần tự (không Promise.all không giới hạn), giới hạn MAX_BATCH_SIZE.
 *
 * Idempotent: gọi lại CÙNG một tập id (double-click nút, network retry, hoặc submit lại
 * nguyên request) sẽ thấy các id đã APPROVED ở lần trước giờ status="INACTIVE" → trả về
 * ALREADY_APPROVED, KHÔNG chạy lại bất kỳ side effect nào (không đóng session lần 2, không
 * dọn allocation lần 2, không ghi audit lần 2) — tái dùng đúng cơ chế status-recheck +
 * row lock đã có sẵn trong applyMovementAction(), không cần bảng/cột/migration mới.
 *
 * RBAC/Data Scope: MỘT guard duy nhất ở đầu request dùng ĐÚNG permission của thao tác đơn lẻ
 * ("workforce_movements.manage") — không mở rộng quyền qua chế độ bulk. Data Scope được kiểm
 * tra LẠI cho TỪNG id (không tin checkbox phía trình duyệt) — 1 id ngoài Data Scope được gửi
 * kèm trong batch sẽ nhận outcome OUT_OF_SCOPE và KHÔNG được duyệt, trong khi các id hợp lệ
 * khác trong cùng batch vẫn được xử lý bình thường.
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "workforce_movements.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let body: { requestIds?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Thiếu danh sách yêu cầu." }, { status: 400 });
  }
  const rawIds = Array.isArray(body.requestIds)
    ? body.requestIds.filter((v): v is string => typeof v === "string" && v.length > 0)
    : null;
  if (!rawIds || rawIds.length === 0) {
    return NextResponse.json({ error: "Chưa chọn yêu cầu nào để duyệt." }, { status: 400 });
  }
  // Trùng id trong cùng 1 request (double-submit phía client) gộp lại còn 1 lần xử lý —
  // vẫn an toàn kể cả không dedup nhờ status-recheck trong applyMovementAction, nhưng dedup
  // giúp kết quả trả về không có 2 dòng cho cùng 1 id.
  const ids = [...new Set(rawIds)];
  if (ids.length > MAX_BATCH_SIZE) {
    return NextResponse.json({ error: `Chỉ được duyệt tối đa ${MAX_BATCH_SIZE} yêu cầu trong 1 lần.` }, { status: 400 });
  }

  const scope = await getUserScope(guard.session);
  const bulkOperationId = randomUUID();

  const rows = await db
    .select({
      id: workforceMovements.id,
      movementType: workforceMovements.movementType,
      status: workforceMovements.status,
      fromDeptId: workforceMovements.fromDeptId,
      toDeptId: workforceMovements.toDeptId,
    })
    .from(workforceMovements)
    .where(inArray(workforceMovements.id, ids));
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const results: { id: string; outcome: BulkOutcome; reason?: string }[] = [];

  // Tuần tự (không Promise.all không giới hạn) — mỗi lần gọi applyMovementAction tự mở
  // transaction + row lock riêng, đủ nhanh cho batch 5-100 và tránh gây áp lực đồng thời
  // không cần thiết lên Production DB.
  for (const id of ids) {
    const row = rowById.get(id);
    if (!row || row.movementType !== "resignation") {
      results.push({ id, outcome: "NO_LONGER_ELIGIBLE" });
      continue;
    }
    const visibility = movementScopeVisibility(scope, row.movementType, row.fromDeptId, row.toDeptId);
    if (visibility !== "FULL") {
      results.push({ id, outcome: "OUT_OF_SCOPE" });
      continue;
    }
    if (row.status === "INACTIVE") {
      results.push({ id, outcome: "ALREADY_APPROVED" });
      continue;
    }
    if (row.status !== "PENDING_HR") {
      results.push({ id, outcome: "NO_LONGER_ELIGIBLE" });
      continue;
    }

    try {
      const { spawnedResignationId } = await applyMovementAction(guard.session, id, "APPROVE_RESIGNATION", {});
      await writeAudit(guard.session, "WORKFORCE_MOVEMENT_APPROVE_RESIGNATION", "workforce_movements", {
        id,
        spawnedResignationId,
        bulkOperationId,
      });
      results.push({ id, outcome: "APPROVED" });
    } catch (error) {
      results.push({ id, outcome: "FAILED", reason: (error as Error).message });
    }
  }

  return NextResponse.json({
    bulkOperationId,
    requested: ids.length,
    approved: results.filter((r) => r.outcome === "APPROVED").length,
    alreadyApproved: results.filter((r) => r.outcome === "ALREADY_APPROVED").length,
    outOfScope: results.filter((r) => r.outcome === "OUT_OF_SCOPE").length,
    noLongerEligible: results.filter((r) => r.outcome === "NO_LONGER_ELIGIBLE").length,
    failed: results.filter((r) => r.outcome === "FAILED").length,
    results,
  });
}
