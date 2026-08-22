import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { departments, employmentSessions, workerProfiles, workforceMovements } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { movementScopeVisibility } from "@/lib/data-scope";
import { queueNotification } from "@/lib/notifications";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { isValidDateStr } from "@/lib/analytics-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Danh sách yêu cầu Nghỉ việc/Thuyên chuyển — lọc theo Data Scope cho DEPT_MANAGER. */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "workforce_movements.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const typeParam = url.searchParams.get("type");

  const filters = [];
  if (statusParam && statusParam !== "ALL") filters.push(eq(workforceMovements.status, statusParam));
  if (typeParam && typeParam !== "ALL") filters.push(eq(workforceMovements.movementType, typeParam));

  // Worker-level movement policy:
  // - source/from scope: full record;
  // - destination-only scope: incoming transfer is visible but PII/business notes are redacted;
  // - no intersection: invisible. Aggregate Transfer Out/In remains directional by from/to.
  const scope = await getUserScope(guard.session);
  if (scope !== null) {
    if (scope.length === 0) return NextResponse.json({ rows: [] });
    filters.push(or(
      inArray(workforceMovements.fromDeptId, scope),
      inArray(workforceMovements.toDeptId, scope),
    )!);
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

  return NextResponse.json({
    rows: rows
      .map((row) => {
        const visibility = movementScopeVisibility(scope, row.movementType, row.fromDeptId, row.toDeptId);
        const full = visibility === "FULL";
        return {
          ...row,
          workerId: full ? row.workerId : null,
          workerName: full ? normalizePersonName(row.workerName ?? "") || null : null,
          workerCccd: full ? row.workerCccd : null,
          reason: full ? row.reason : null,
          note: full ? row.note : null,
          requestedBy: full ? row.requestedBy : null,
          relatedMovementId: full ? row.relatedMovementId : null,
          scopeVisibility: visibility,
        };
      })
      .filter((row) => row.scopeVisibility !== "NONE"),
  });
}

/** Tạo yêu cầu mới (Manager/Nhân viên hành chính) — RESIGNATION hoặc TRANSFER. */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], "workforce_movements.create");
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
  // B3 (Production Recovery audit) — effectiveDate trước đây nhận thẳng từ body, không kiểm tra
  // định dạng, có thể ghi 1 chuỗi rác/invalid xuống DB hoặc lệch định dạng ngày.
  if (!isValidDateStr(body.effectiveDate)) {
    return NextResponse.json({ error: "Ngày hiệu lực không hợp lệ (định dạng YYYY-MM-DD)." }, { status: 400 });
  }
  if (body.movementType === "transfer" && !body.toDeptId) {
    return NextResponse.json({ error: "Thuyên chuyển cần chọn Bộ phận mới." }, { status: 400 });
  }
  if (body.movementType === "transfer" && body.toDeptId) {
    const [destination] = await db
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.id, body.toDeptId), eq(departments.isActive, true), isNull(departments.deletedAt)));
    if (!destination) return NextResponse.json({ error: "Bộ phận đích không tồn tại hoặc đã ngừng hoạt động." }, { status: 400 });
  }

  // P0-4 (Production Hardening Audit) — TRƯỚC ĐÂY `fromDeptId` lấy thẳng từ request body (client
  // có thể gửi bất kỳ giá trị nào) — authorization bypass: 1 DEPT_MANAGER có thể tự khai
  // `fromDeptId` trùng bộ phận mình quản lý dù lao động thật KHÔNG thuộc bộ phận đó. Server giờ
  // tự xác định bộ phận HIỆN TẠI của lao động từ employment_sessions gần nhất (nguồn dữ liệu
  // nghiệp vụ chuẩn — cùng cách applyMovementAction() xác định bộ phận thật ở lib/workforce-movements.ts),
  // KHÔNG tin giá trị `fromDeptId` do client gửi lên.
  // EMPLOYMENT LIFECYCLE (#4) — yêu cầu Nghỉ việc/Thuyên chuyển phải bám vào ĐÚNG Employment
  // Session ACTIVE (APPROVED + end_date IS NULL), không phải "session gần nhất theo regDate"
  // (session gần nhất có thể là 1 đăng ký PENDING mới của cùng người).
  //
  // B2 (Production Recovery audit) — TRƯỚC ĐÂY select session + insert movement KHÔNG bọc trong
  // transaction, KHÔNG lock, KHÔNG kiểm tra đã có yêu cầu PENDING_HR nào khác cho cùng session:
  // 2 request đồng thời (double-click, hoặc 2 người thao tác) có thể cùng đọc fromDeptId=A rồi
  // cùng tạo 2 movement PENDING_HR khác nhau — khi HR duyệt cả 2 lần lượt, lần duyệt thứ 2 dùng
  // deptId HIỆN TẠI (đã đổi sau lần 1) làm from thật nhưng cột fromDeptId lưu lúc tạo vẫn là A cũ
  // → lịch sử ghi sai "A → C" thay vì "A → B → C". Fix: lock session row (`for("update")`, cùng
  // pattern với /api/employment/resignation-requests) + idempotent — đã có PENDING_HR cho session
  // này (dù resignation hay transfer) thì KHÔNG tạo thêm, trả về yêu cầu đang chờ.
  // DYNAMIC RBAC V2 — bỏ proxy role === DEPT_MANAGER: user có Data Scope (scope != null) chỉ
  // được tạo yêu cầu cho lao động thuộc bộ phận mình quản lý. Lấy scope TRƯỚC transaction (không
  // phụ thuộc dữ liệu trong transaction) để kiểm tra NGAY khi biết actualFromDeptId — TRƯỚC insert,
  // không phải sau (insert-rồi-mới-check-authorization sẽ để lọt 1 row đã ghi xuống DB dù 403).
  const scope = await getUserScope(guard.session);

  const result = await db.transaction(async (tx) => {
    const [activeSession] = await tx
      .select({ id: employmentSessions.id, deptId: employmentSessions.deptId })
      .from(employmentSessions)
      .innerJoin(workerProfiles, and(eq(employmentSessions.workerId, workerProfiles.id), isNull(workerProfiles.deletedAt)))
      .where(and(
        eq(employmentSessions.workerId, body.workerId!),
        eq(employmentSessions.status, "APPROVED"),
        isNull(employmentSessions.endDate),
      ))
      .orderBy(desc(employmentSessions.regDate), desc(employmentSessions.createdAt))
      .limit(1)
      .for("update");
    if (!activeSession) {
      return { error: "Lao động không có Employment Session active để tạo yêu cầu.", status: 400 } as const;
    }
    const actualFromDeptId = activeSession.deptId;

    // B1 (Production Recovery audit) — thuyên chuyển với đích trùng bộ phận hiện tại: vô nghĩa,
    // gây "transfer" giả trong lịch sử/thống kê.
    if (body.movementType === "transfer" && body.toDeptId === actualFromDeptId) {
      return { error: "Bộ phận đích trùng bộ phận hiện tại — không phải thuyên chuyển.", status: 400 } as const;
    }

    if (scope && !scope.includes(actualFromDeptId ?? "")) {
      return { error: "Lao động này không thuộc bộ phận bạn quản lý.", status: 403 } as const;
    }

    // Idempotent — session này đã có 1 yêu cầu PENDING_HR (resignation hoặc transfer) rồi thì
    // không tạo thêm; 1 session ACTIVE chỉ nên có tối đa 1 yêu cầu đang chờ tại 1 thời điểm.
    const [existingPending] = await tx
      .select({ id: workforceMovements.id, movementType: workforceMovements.movementType })
      .from(workforceMovements)
      .where(and(
        eq(workforceMovements.employmentSessionId, activeSession.id),
        eq(workforceMovements.status, "PENDING_HR"),
      ))
      .limit(1);
    if (existingPending) {
      return {
        error: `Lao động này đã có 1 yêu cầu (${existingPending.movementType}) đang chờ HR xử lý — không thể tạo thêm.`,
        status: 409,
      } as const;
    }

    const [row] = await tx
      .insert(workforceMovements)
      .values({
        movementType: body.movementType!,
        workerId: body.workerId!,
        fromDeptId: actualFromDeptId,
        toDeptId: body.movementType === "transfer" ? body.toDeptId : null,
        // EMPLOYMENT LIFECYCLE — truy vết đủ: movement thuộc session nào + nguồn báo cáo.
        employmentSessionId: activeSession.id,
        source: "DEPT_REPORT",
        effectiveDate: body.effectiveDate!,
        reason: body.reason || null,
        note: body.note || null,
        status: "PENDING_HR",
        requestedBy: guard.session.username,
      })
      .returning();

    return { row, actualFromDeptId } as const;
  });

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const { row } = result;

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
