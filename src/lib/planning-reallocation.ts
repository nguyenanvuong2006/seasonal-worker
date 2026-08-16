import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  departments,
  employmentSessions,
  planningAllocations,
  planningTasks,
  recruitmentRequests,
  workerProfiles,
  workforceMovements,
} from "@/db/schema";
import { todayStr, isMale, isFemale } from "@/lib/helpers";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import {
  TASK_PLANNING_REALLOCATION_REQUIRED,
  buildReallocationTaskTitle,
  isRequestExpired,
  isTerminalStatus,
  shouldAutoCloseReallocationTask,
  validateReallocationInput,
} from "@/lib/planning-recruitment-core";

/* ============================================================
   PLANNING — HẾT HẠN YÊU CẦU & TÁI PHÂN BỔ DW
   ------------------------------------------------------------
   QUY TẮC CỨNG XUYÊN SUỐT FILE NÀY (Yêu cầu #7 & #9):

     Yêu cầu tuyển dụng HẾT HẠN  ≠  DW NGHỈ VIỆC

   Khi một Recruitment Request quá End Date, module này:
     ✔ đổi status sang EXPIRED (KHÔNG phải CANCELLED)
     ✔ tạo Task Center nhắc Recruiter chuyển phân bổ
     ✘ KHÔNG ghi workforce_movements RESIGNATION
     ✘ KHÔNG set employment_sessions.end_date
     ✘ KHÔNG set bất kỳ cờ inactive / quit date nào cho DW

   Chỉ workforce_movements loại RESIGNATION mới là nghỉ việc thật.
   ============================================================ */

export type OpenAllocationRow = {
  allocationId: string;
  employmentSessionId: string;
  workerId: string;
  workerName: string | null;
  workerCccd: string | null;
  gender: string | null;
  deptId: string | null;
  allocationStartDate: string | null;
};

/** Các phân bổ ĐANG MỞ (allocation_end_date IS NULL) gắn với 1 yêu cầu. */
export async function listOpenAllocationsForRequest(requestId: string): Promise<OpenAllocationRow[]> {
  const rows = await db
    .select({
      allocationId: planningAllocations.id,
      employmentSessionId: planningAllocations.employmentSessionId,
      workerId: employmentSessions.workerId,
      workerName: workerProfiles.fullName,
      workerCccd: workerProfiles.cccd,
      gender: workerProfiles.gender,
      deptId: employmentSessions.deptId,
      allocationStartDate: planningAllocations.allocationStartDate,
    })
    .from(planningAllocations)
    .innerJoin(employmentSessions, eq(planningAllocations.employmentSessionId, employmentSessions.id))
    .leftJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .where(
      and(
        eq(planningAllocations.recruitmentRequestId, requestId),
        isNull(planningAllocations.allocationEndDate),
        // Chỉ DW còn đang làm việc mới cần chuyển phân bổ.
        eq(employmentSessions.status, "APPROVED"),
        isNull(employmentSessions.endDate),
      ),
    );

  return rows;
}

function countByGender(rows: { gender: string | null }[]) {
  let male = 0;
  let female = 0;
  for (const r of rows) {
    if (isFemale(r.gender)) female += 1;
    else if (isMale(r.gender)) male += 1;
  }
  return { male, female, total: rows.length };
}

/* ============================================================
   1. QUÉT YÊU CẦU HẾT HẠN + TẠO TASK (Yêu cầu #7 & #14)
   ============================================================ */
export type ExpiryScanResult = {
  scanned: number;
  markedExpired: number;
  tasksCreated: number;
  tasksAutoClosed: number;
};

/**
 * Job định kỳ: quét yêu cầu quá End Date.
 *
 * IDEMPOTENT — chạy lại bao nhiêu lần cũng KHÔNG sinh task trùng, nhờ:
 *   1. unique index partial `planning_tasks_open_uq` trên
 *      (task_type, recruitment_request_id) WHERE status IN (OPEN, IN_PROGRESS);
 *   2. onConflictDoNothing ở tầng ứng dụng.
 */
export async function scanExpiredRequestsAndCreateTasks(
  today = todayStr(),
): Promise<ExpiryScanResult> {
  const result: ExpiryScanResult = { scanned: 0, markedExpired: 0, tasksCreated: 0, tasksAutoClosed: 0 };

  // Yêu cầu quá End Date và CHƯA ở trạng thái kết thúc.
  const candidates = await db
    .select({
      id: recruitmentRequests.id,
      requestCode: recruitmentRequests.requestCode,
      status: recruitmentRequests.status,
      endDate: recruitmentRequests.endDate,
      department: recruitmentRequests.department,
      departmentId: recruitmentRequests.departmentId,
      section: recruitmentRequests.section,
      groupName: recruitmentRequests.groupName,
      planningPeriodId: recruitmentRequests.planningPeriodId,
    })
    .from(recruitmentRequests)
    .where(
      and(
        isNull(recruitmentRequests.deletedAt),
        sql`${recruitmentRequests.endDate} is not null`,
        sql`${recruitmentRequests.endDate} < ${today}`,
        sql`${recruitmentRequests.status} not in ('COMPLETED', 'CANCELLED')`,
      ),
    );

  result.scanned = candidates.length;

  for (const req of candidates) {
    if (!isRequestExpired({ endDate: req.endDate, status: req.status }, today)) continue;

    const openAllocations = await listOpenAllocationsForRequest(req.id);

    await db.transaction(async (tx) => {
      // (a) Đánh dấu EXPIRED — KHÔNG BAO GIỜ là CANCELLED.
      if (req.status !== "EXPIRED") {
        await tx
          .update(recruitmentRequests)
          .set({ status: "EXPIRED", updatedAt: new Date() })
          .where(and(eq(recruitmentRequests.id, req.id), isNull(recruitmentRequests.deletedAt)));
        result.markedExpired += 1;
      }

      // (b) Không còn DW nào được phân bổ → không cần Task nào cả.
      if (openAllocations.length === 0) {
        const closed = await tx
          .update(planningTasks)
          .set({ status: "DONE", resolvedAt: new Date(), resolvedBy: "SYSTEM", updatedAt: new Date() })
          .where(
            and(
              eq(planningTasks.taskType, TASK_PLANNING_REALLOCATION_REQUIRED),
              eq(planningTasks.recruitmentRequestId, req.id),
              inArray(planningTasks.status, ["OPEN", "IN_PROGRESS"]),
            ),
          );
        result.tasksAutoClosed += closed.rowCount ?? 0;
        return;
      }

      // (c) Còn DW đang phân bổ → tạo Task nhắc Recruiter chuyển phân bổ.
      //     TUYỆT ĐỐI KHÔNG động vào employment_sessions / workforce_movements.
      const counts = countByGender(openAllocations);
      const inserted = await tx
        .insert(planningTasks)
        .values({
          taskType: TASK_PLANNING_REALLOCATION_REQUIRED,
          status: "OPEN",
          recruitmentRequestId: req.id,
          planningPeriodId: req.planningPeriodId,
          departmentId: req.departmentId,
          title: buildReallocationTaskTitle(req.requestCode),
          dueDate: req.endDate,
          detail: {
            requestCode: req.requestCode,
            department: req.department,
            departmentId: req.departmentId,
            section: req.section,
            groupName: req.groupName,
            endDate: req.endDate,
            totalActiveAllocations: counts.total,
            maleCount: counts.male,
            femaleCount: counts.female,
            workers: openAllocations.map((a) => ({
              allocationId: a.allocationId,
              employmentSessionId: a.employmentSessionId,
              workerId: a.workerId,
              fullName: a.workerName,
              cccd: a.workerCccd,
              gender: a.gender,
            })),
          },
        })
        .onConflictDoNothing()
        .returning({ id: planningTasks.id });

      result.tasksCreated += inserted.length;
    });
  }

  return result;
}

/* ============================================================
   2. TÁI PHÂN BỔ (Yêu cầu #8)
   ============================================================ */
export type ReallocateInput = {
  fromRequestId: string;
  toRequestId: string;
  allocationIds: string[];
  actor: string;
  /** Data Scope của người thực hiện: null = không giới hạn. */
  scope: string[] | null;
  today?: string;
};

export type ReallocateResult =
  | {
      ok: true;
      moved: number;
      newAllocationIds: string[];
      taskClosed: boolean;
      /** Bằng chứng: không có DW nào bị đánh dấu nghỉ việc. */
      resignationsCreated: 0;
    }
  | { ok: false; status: number; error: string };

/**
 * Chuyển phân bổ DW từ yêu cầu CŨ sang yêu cầu MỚI — trong MỘT transaction.
 *
 * Quy trình cho mỗi phân bổ:
 *   1. ĐÓNG phân bổ cũ  → set allocation_end_date, reallocated_by/at.
 *      Bản ghi cũ VẪN NẰM NGUYÊN trong bảng (append-only, truy vết được).
 *   2. TẠO phân bổ mới  → previous_allocation_id trỏ về bản cũ.
 *   3. DW GIỮ NGUYÊN trạng thái đang làm việc:
 *        - không tạo workforce_movements RESIGNATION,
 *        - không ghi employment_sessions.end_date,
 *        - không set cờ inactive nào.
 *   4. Tự động đóng Task tái phân bổ khi yêu cầu cũ hết DW đang mở.
 */
export async function reallocateDws(input: ReallocateInput): Promise<ReallocateResult> {
  const today = input.today ?? todayStr();

  const check = validateReallocationInput(input);
  if (!check.ok) return { ok: false, status: 400, error: check.error };

  return db.transaction(async (tx) => {
    // --- Nạp & khoá hai yêu cầu ---------------------------------------
    const [fromReq] = await tx
      .select()
      .from(recruitmentRequests)
      .where(and(eq(recruitmentRequests.id, input.fromRequestId), isNull(recruitmentRequests.deletedAt)))
      .for("update");
    const [toReq] = await tx
      .select()
      .from(recruitmentRequests)
      .where(and(eq(recruitmentRequests.id, input.toRequestId), isNull(recruitmentRequests.deletedAt)))
      .for("update");

    // 404 (không phải 403) để không lộ sự tồn tại của bản ghi ngoài Data Scope.
    if (!fromReq) return { ok: false as const, status: 404, error: "Không tìm thấy yêu cầu nguồn." };
    if (!toReq) return { ok: false as const, status: 404, error: "Không tìm thấy yêu cầu đích." };

    // --- DATA SCOPE: chặn phía SERVER, cả hai đầu (Yêu cầu #15) --------
    if (!scopeAllowsDepartment(input.scope, fromReq.departmentId)) {
      return { ok: false as const, status: 404, error: "Không tìm thấy yêu cầu nguồn." };
    }
    if (!scopeAllowsDepartment(input.scope, toReq.departmentId)) {
      return { ok: false as const, status: 404, error: "Không tìm thấy yêu cầu đích." };
    }

    // --- Yêu cầu đích phải còn nhận được người ------------------------
    if (isTerminalStatus(toReq.status)) {
      return {
        ok: false as const,
        status: 409,
        error: `Yêu cầu đích đang ở trạng thái ${toReq.status}, không thể nhận phân bổ mới.`,
      };
    }
    if (toReq.endDate && toReq.endDate < today) {
      return { ok: false as const, status: 409, error: "Yêu cầu đích cũng đã hết hạn. Hãy chọn yêu cầu còn hiệu lực." };
    }

    // --- Nạp & khoá các phân bổ được chọn ------------------------------
    const allocations = await tx
      .select({
        id: planningAllocations.id,
        employmentSessionId: planningAllocations.employmentSessionId,
        planningPeriodId: planningAllocations.planningPeriodId,
        recruitmentRequestId: planningAllocations.recruitmentRequestId,
        allocationEndDate: planningAllocations.allocationEndDate,
        allocationStartDate: planningAllocations.allocationStartDate,
      })
      .from(planningAllocations)
      .where(inArray(planningAllocations.id, input.allocationIds))
      .for("update");

    if (allocations.length !== input.allocationIds.length) {
      return { ok: false as const, status: 404, error: "Một số phân bổ không tồn tại." };
    }
    for (const a of allocations) {
      if (a.recruitmentRequestId !== fromReq.id) {
        return { ok: false as const, status: 409, error: "Có phân bổ không thuộc yêu cầu nguồn đã chọn." };
      }
      if (a.allocationEndDate !== null) {
        return { ok: false as const, status: 409, error: "Có phân bổ đã được chuyển trước đó." };
      }
    }

    // Kế hoạch đích: ưu tiên planning period của yêu cầu đích, nếu chưa gắn
    // thì giữ nguyên period cũ để không phá liên kết planning_periods hiện có.
    const targetPeriodId = toReq.planningPeriodId;

    const newAllocationIds: string[] = [];

    for (const a of allocations) {
      // BƯỚC 1 — ĐÓNG phân bổ cũ (KHÔNG xoá, KHÔNG ghi đè lịch sử).
      await tx
        .update(planningAllocations)
        .set({
          allocationEndDate: today,
          reallocatedBy: input.actor,
          reallocatedAt: new Date(),
        })
        .where(eq(planningAllocations.id, a.id));

      // BƯỚC 2 — TẠO phân bổ mới, nối chuỗi truy vết về bản cũ.
      const [created] = await tx
        .insert(planningAllocations)
        .values({
          employmentSessionId: a.employmentSessionId,
          planningPeriodId: targetPeriodId ?? a.planningPeriodId,
          recruitmentRequestId: toReq.id,
          allocatedBy: input.actor,
          allocationStartDate: today,
          previousAllocationId: a.id,
        })
        .returning({ id: planningAllocations.id });

      if (created) newAllocationIds.push(created.id);

      // BƯỚC 3 — KHÔNG làm gì với employment_sessions / workforce_movements.
      // DW vẫn đang làm việc bình thường. Đây là điểm mấu chốt của Yêu cầu #9.
    }

    // BƯỚC 4 — Yêu cầu cũ hết DW đang mở thì đóng Task tái phân bổ.
    const [{ remaining }] = await tx
      .select({ remaining: sql<number>`count(*)::int` })
      .from(planningAllocations)
      .where(
        and(
          eq(planningAllocations.recruitmentRequestId, fromReq.id),
          isNull(planningAllocations.allocationEndDate),
        ),
      );

    let taskClosed = false;
    if (shouldAutoCloseReallocationTask(remaining)) {
      const closed = await tx
        .update(planningTasks)
        .set({ status: "DONE", resolvedAt: new Date(), resolvedBy: input.actor, updatedAt: new Date() })
        .where(
          and(
            eq(planningTasks.taskType, TASK_PLANNING_REALLOCATION_REQUIRED),
            eq(planningTasks.recruitmentRequestId, fromReq.id),
            inArray(planningTasks.status, ["OPEN", "IN_PROGRESS"]),
          ),
        );
      taskClosed = (closed.rowCount ?? 0) > 0;
    }

    return {
      ok: true as const,
      moved: allocations.length,
      newAllocationIds,
      taskClosed,
      resignationsCreated: 0 as const,
    };
  });
}

/* ============================================================
   3. LỊCH SỬ PHÂN BỔ CỦA 1 DW (truy vết append-only)
   ============================================================ */
export async function getAllocationHistory(employmentSessionId: string) {
  return db
    .select({
      id: planningAllocations.id,
      planningPeriodId: planningAllocations.planningPeriodId,
      recruitmentRequestId: planningAllocations.recruitmentRequestId,
      requestCode: recruitmentRequests.requestCode,
      allocationStartDate: planningAllocations.allocationStartDate,
      allocationEndDate: planningAllocations.allocationEndDate,
      previousAllocationId: planningAllocations.previousAllocationId,
      allocatedBy: planningAllocations.allocatedBy,
      allocatedAt: planningAllocations.allocatedAt,
      reallocatedBy: planningAllocations.reallocatedBy,
      reallocatedAt: planningAllocations.reallocatedAt,
    })
    .from(planningAllocations)
    .leftJoin(recruitmentRequests, eq(planningAllocations.recruitmentRequestId, recruitmentRequests.id))
    .where(eq(planningAllocations.employmentSessionId, employmentSessionId))
    .orderBy(planningAllocations.allocatedAt);
}

/* ============================================================
   4. TASK CENTER — LIỆT KÊ THEO DATA SCOPE (Yêu cầu #15)
   ============================================================ */
export async function listReallocationTasks(scope: string[] | null, limit = 100) {
  const conditions = [
    eq(planningTasks.taskType, TASK_PLANNING_REALLOCATION_REQUIRED),
    inArray(planningTasks.status, ["OPEN", "IN_PROGRESS"]),
  ];

  // scope === null  → không giới hạn (ADMIN / HR).
  // scope === []    → không thấy gì.
  if (scope !== null) {
    if (scope.length === 0) return [];
    conditions.push(inArray(planningTasks.departmentId, scope));
  }

  return db
    .select({
      id: planningTasks.id,
      taskType: planningTasks.taskType,
      status: planningTasks.status,
      title: planningTasks.title,
      detail: planningTasks.detail,
      dueDate: planningTasks.dueDate,
      recruitmentRequestId: planningTasks.recruitmentRequestId,
      departmentId: planningTasks.departmentId,
      departmentName: departments.deptName,
      createdAt: planningTasks.createdAt,
    })
    .from(planningTasks)
    .leftJoin(departments, eq(planningTasks.departmentId, departments.id))
    .where(and(...conditions))
    .orderBy(planningTasks.dueDate)
    .limit(limit);
}

/** Yêu cầu còn hiệu lực trong cùng Data Scope — để Recruiter chọn đích chuyển. */
export async function listReallocationTargets(
  scope: string[] | null,
  opts: { excludeRequestId?: string; departmentId?: string | null; today?: string } = {},
) {
  const today = opts.today ?? todayStr();
  const conditions = [
    isNull(recruitmentRequests.deletedAt),
    sql`${recruitmentRequests.status} in ('PENDING', 'PROCESSING')`,
    sql`(${recruitmentRequests.endDate} is null or ${recruitmentRequests.endDate} >= ${today})`,
  ];

  if (scope !== null) {
    if (scope.length === 0) return [];
    conditions.push(inArray(recruitmentRequests.departmentId, scope));
  }
  if (opts.excludeRequestId) {
    conditions.push(sql`${recruitmentRequests.id} <> ${opts.excludeRequestId}`);
  }
  if (opts.departmentId) {
    conditions.push(eq(recruitmentRequests.departmentId, opts.departmentId));
  }

  return db
    .select({
      id: recruitmentRequests.id,
      requestCode: recruitmentRequests.requestCode,
      department: recruitmentRequests.department,
      departmentId: recruitmentRequests.departmentId,
      section: recruitmentRequests.section,
      groupName: recruitmentRequests.groupName,
      expectedDate: recruitmentRequests.expectedDate,
      endDate: recruitmentRequests.endDate,
      totalBalance: recruitmentRequests.totalBalance,
      status: recruitmentRequests.status,
    })
    .from(recruitmentRequests)
    .where(and(...conditions))
    .orderBy(recruitmentRequests.expectedDate)
    .limit(200);
}

/* ============================================================
   5. KIỂM CHỨNG: KHÔNG CÓ NGHỈ VIỆC NÀO ĐƯỢC SINH RA
   ------------------------------------------------------------
   Dùng trong test tích hợp và trong báo cáo đối soát: đếm số
   RESIGNATION của các DW liên quan tới 1 yêu cầu tuyển dụng.
   Sau khi tái phân bổ, con số này PHẢI không đổi.
   ============================================================ */
export async function countResignationsForRequest(requestId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(workforceMovements)
    .innerJoin(employmentSessions, eq(workforceMovements.workerId, employmentSessions.workerId))
    .innerJoin(planningAllocations, eq(planningAllocations.employmentSessionId, employmentSessions.id))
    .where(
      and(
        eq(planningAllocations.recruitmentRequestId, requestId),
        sql`lower(${workforceMovements.movementType}) = 'resignation'`,
      ),
    );
  return row?.n ?? 0;
}
