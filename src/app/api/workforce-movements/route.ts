import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions, workerProfiles, workforceMovements } from "@/db/schema";
import { getUserScope, requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { queueNotification } from "@/lib/notifications";
import { todayStr } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Danh sách yêu cầu Nghỉ việc/Thuyên chuyển — lọc theo Data Scope cho DEPT_MANAGER. */
export async function GET(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], "workforce_movements.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const typeParam = url.searchParams.get("type");

  const filters = [];
  if (statusParam && statusParam !== "ALL") filters.push(eq(workforceMovements.status, statusParam));
  if (typeParam && typeParam !== "ALL") filters.push(eq(workforceMovements.movementType, typeParam));

  if (guard.session.role === "DEPT_MANAGER") {
    const scope = await getUserScope(guard.session);
    if (!scope || scope.length === 0) return NextResponse.json({ rows: [] });
    filters.push(inArray(workforceMovements.fromDeptId, scope));
  }

  const rows = await db
    .select({
      id: workforceMovements.id,
      movementType: workforceMovements.movementType,
      workerId: workforceMovements.workerId,
      workerName: workerProfiles.fullName,
      workerCccd: workerProfiles.cccd,
      fromDeptId: workforceMovements.fromDeptId,
      toDeptId: workforceMovements.toDeptId,
      effectiveDate: workforceMovements.effectiveDate,
      reason: workforceMovements.reason,
      note: workforceMovements.note,
      status: workforceMovements.status,
      relatedMovementId: workforceMovements.relatedMovementId,
      requestedBy: workforceMovements.requestedBy,
      createdAt: workforceMovements.createdAt,
    })
    .from(workforceMovements)
    .leftJoin(workerProfiles, eq(workforceMovements.workerId, workerProfiles.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(workforceMovements.createdAt))
    .limit(500);

  return NextResponse.json({ rows });
}

/** Tạo yêu cầu mới (Manager/Nhân viên hành chính) — RESIGNATION hoặc TRANSFER. */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], "workforce_movements.create");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    movementType?: "resignation" | "transfer";
    workerId?: string;
    toDeptId?: string;
    effectiveDate?: string;
    reason?: string;
    note?: string;
  };

  if (!body.movementType || !body.workerId || !body.effectiveDate) {
    return NextResponse.json({ error: "Thiếu loại yêu cầu, lao động, hoặc ngày hiệu lực." }, { status: 400 });
  }
  if (body.movementType === "transfer" && !body.toDeptId) {
    return NextResponse.json({ error: "Thuyên chuyển cần chọn Bộ phận mới." }, { status: 400 });
  }

  // P0-4 (Production Hardening Audit) — TRƯỚC ĐÂY `fromDeptId` lấy thẳng từ request body (client
  // có thể gửi bất kỳ giá trị nào) — authorization bypass: 1 DEPT_MANAGER có thể tự khai
  // `fromDeptId` trùng bộ phận mình quản lý dù lao động thật KHÔNG thuộc bộ phận đó. Server giờ
  // tự xác định bộ phận HIỆN TẠI của lao động từ employment_sessions gần nhất (nguồn dữ liệu
  // nghiệp vụ chuẩn — cùng cách applyMovementAction() xác định bộ phận thật ở lib/workforce-movements.ts),
  // KHÔNG tin giá trị `fromDeptId` do client gửi lên.
  const [latestSession] = await db
    .select({ deptId: employmentSessions.deptId })
    .from(employmentSessions)
    .where(eq(employmentSessions.workerId, body.workerId))
    .orderBy(desc(employmentSessions.regDate))
    .limit(1);
  const actualFromDeptId = latestSession?.deptId ?? null;

  if (guard.session.role === "DEPT_MANAGER") {
    const scope = await getUserScope(guard.session);
    if (!actualFromDeptId || !scope || !scope.includes(actualFromDeptId)) {
      return NextResponse.json({ error: "Lao động này không thuộc bộ phận bạn quản lý." }, { status: 403 });
    }
  }

  const [row] = await db
    .insert(workforceMovements)
    .values({
      movementType: body.movementType,
      workerId: body.workerId,
      fromDeptId: actualFromDeptId,
      toDeptId: body.movementType === "transfer" ? body.toDeptId : null,
      effectiveDate: body.effectiveDate,
      reason: body.reason || null,
      note: body.note || null,
      status: "PENDING_HR",
      requestedBy: guard.session.username,
    })
    .returning();

  await writeAudit(guard.session, "CREATE_WORKFORCE_MOVEMENT", "workforce_movements", { id: row.id, movementType: row.movementType });

  // Notification: Manager tạo -> HR nhận (đúng mục 9 yêu cầu nghiệp vụ).
  await queueNotification({
    event: "WORKFORCE_MOVEMENT_CREATED",
    recipientType: "ROLE",
    recipientRef: "HR_RECRUITER",
    templateKey: "workforce_movement_created",
    payload: { id: row.id, movementType: row.movementType, requestedBy: guard.session.username, effectiveDate: body.effectiveDate ?? todayStr() },
  });

  return NextResponse.json({ success: true, row });
}
