import "server-only";
import { and, desc, eq, inArray, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  departments,
  employmentSessions,
  planningAllocations,
  planningPeriods,
  planningTargets,
  workerProfiles,
  workforceMovements,
} from "@/db/schema";
import { isFemale, isMale, todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { mirrorPlanningAllocationToRequest } from "@/lib/workforce-request";
import type { RequestKpi, WarningDetail } from "@/lib/workforce-request-kpi";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PlanningMetrics = {
  demandMale: number;
  demandFemale: number;
  demandTotal: number;
  allocatedMale: number;
  allocatedFemale: number;
  allocatedTotal: number;
  resignedMale: number;
  resignedFemale: number;
  resignedTotal: number;
  recruitmentNeededMale: number;
  recruitmentNeededFemale: number;
  recruitmentNeededTotal: number;
  fillRatePercent: number;
};

/**
 * Tạo kế hoạch Tập nghề mới (Gốc hoặc Bổ sung).
 * Nghiệp vụ mới: Cho phép NHIỀU kế hoạch trùng thời gian cho cùng Department / Section / Group.
 * Phân biệt:
 *   - ORIGINAL: Kế hoạch gốc (supplementIndex = 0)
 *   - SUPPLEMENT: Yêu cầu bổ sung (supplementIndex = 1, 2, 3...)
 */
export async function createPeriod(input: {
  departmentId: string;
  section?: string | null;
  groupName?: string | null;
  startDate: string;
  endDate: string;
  demandMale: number;
  demandFemale: number;
  targetCount?: number;
  requestType?: "ORIGINAL" | "SUPPLEMENT";
  parentPeriodId?: string | null;
  note?: string;
  createdBy: string;
  activateNow?: boolean;
}) {
  if (input.startDate > input.endDate) {
    throw new Error("Ngày bắt đầu phải trước ngày kết thúc.");
  }
  const demandMale = Math.max(0, Number(input.demandMale) || 0);
  const demandFemale = Math.max(0, Number(input.demandFemale) || 0);
  const targetCount = input.targetCount !== undefined && input.targetCount > 0
    ? Number(input.targetCount)
    : demandMale + demandFemale;

  if (targetCount <= 0 && demandMale <= 0 && demandFemale <= 0) {
    throw new Error("Nhu cầu nhân lực phải lớn hơn 0.");
  }

  const [dept] = await db
    .select()
    .from(departments)
    .where(eq(departments.id, input.departmentId));

  const section = input.section ?? dept?.section ?? dept?.groupName ?? null;
  const groupName = input.groupName ?? dept?.groupName ?? null;
  const location = dept?.location ?? "";
  const division = dept?.division ?? "";

  const requestType = input.requestType ?? "ORIGINAL";
  let supplementIndex = 0;
  let parentPeriodId = input.parentPeriodId ?? null;

  if (requestType === "SUPPLEMENT") {
    // Tự động xác định số thứ tự bổ sung (Bổ sung 1, 2, 3...)
    const existingSupplements = await db
      .select({ supplementIndex: planningPeriods.supplementIndex, id: planningPeriods.id })
      .from(planningPeriods)
      .where(
        and(
          eq(planningPeriods.departmentId, input.departmentId),
          eq(planningPeriods.requestType, "SUPPLEMENT"),
        ),
      )
      .orderBy(desc(planningPeriods.supplementIndex));

    supplementIndex = (existingSupplements[0]?.supplementIndex ?? 0) + 1;

    if (!parentPeriodId) {
      // Tìm kế hoạch gốc gần nhất nếu chưa truyền parentPeriodId
      const [orig] = await db
        .select({ id: planningPeriods.id })
        .from(planningPeriods)
        .where(
          and(
            eq(planningPeriods.departmentId, input.departmentId),
            eq(planningPeriods.requestType, "ORIGINAL"),
          ),
        )
        .orderBy(desc(planningPeriods.createdAt))
        .limit(1);
      parentPeriodId = orig?.id ?? null;
    }
  }

  const [period] = await db
    .insert(planningPeriods)
    .values({
      departmentId: input.departmentId,
      section,
      groupName,
      location,
      division,
      startDate: input.startDate,
      endDate: input.endDate,
      status: input.activateNow ? "ACTIVE" : "DRAFT",
      version: 1,
      requestType,
      supplementIndex,
      parentPeriodId,
      createdBy: input.createdBy,
    })
    .returning();

  await db.insert(planningTargets).values({
    planningPeriodId: period.id,
    demandMale,
    demandFemale,
    targetCount,
    note: input.note ?? null,
  });

  return period;
}

/** Kích hoạt 1 kế hoạch DRAFT -> ACTIVE. */
export async function activatePeriod(periodId: string) {
  const [period] = await db.select().from(planningPeriods).where(eq(planningPeriods.id, periodId));
  if (!period) throw new Error("Không tìm thấy kế hoạch.");
  if (period.status !== "DRAFT") throw new Error("Chỉ có thể kích hoạt kế hoạch đang ở trạng thái Draft.");

  const [updated] = await db
    .update(planningPeriods)
    .set({ status: "ACTIVE", updatedAt: new Date() })
    .where(eq(planningPeriods.id, periodId))
    .returning();
  return updated;
}

/**
 * Sửa 1 kế hoạch ACTIVE = tạo bản ghi VERSION MỚI (giữ nguyên lịch sử bản cũ).
 * Bản cũ được đánh dấu supersededBy trỏ tới bản mới, status -> EXPIRED.
 * Phân biệt rõ:
 *   - Versioning: Thay đổi nội dung của chính kế hoạch đó (tạo version mới)
 *   - Supplement: Thêm nhu cầu mới độc lập cùng khoảng thời gian
 */
export async function reviseActivePeriod(
  periodId: string,
  input: {
    startDate?: string;
    endDate?: string;
    demandMale?: number;
    demandFemale?: number;
    targetCount?: number;
    note?: string;
  },
  revisedBy: string,
) {
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(planningPeriods).where(eq(planningPeriods.id, periodId)).for("update");
    if (!old) throw new Error("Không tìm thấy kế hoạch.");
    if (old.status !== "ACTIVE") {
      throw new Error("Chỉ sửa được kế hoạch đang ACTIVE (kế hoạch Draft có thể sửa trực tiếp, Expired thì tạo kế hoạch mới).");
    }

    const newStartDate = input.startDate ?? old.startDate;
    const newEndDate = input.endDate ?? old.endDate;
    if (newStartDate > newEndDate) throw new Error("Ngày bắt đầu phải trước ngày kết thúc.");

    const [oldTarget] = await tx.select().from(planningTargets).where(eq(planningTargets.planningPeriodId, old.id));

    const demandMale = input.demandMale !== undefined ? Math.max(0, Number(input.demandMale)) : (oldTarget?.demandMale ?? 0);
    const demandFemale = input.demandFemale !== undefined ? Math.max(0, Number(input.demandFemale)) : (oldTarget?.demandFemale ?? 0);
    const targetCount = input.targetCount !== undefined && input.targetCount > 0
      ? Number(input.targetCount)
      : (demandMale + demandFemale > 0 ? demandMale + demandFemale : (oldTarget?.targetCount ?? 0));

    // BƯỚC 1: Đánh dấu bản cũ hết hạn
    await tx.update(planningPeriods).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(planningPeriods.id, old.id));

    // BƯỚC 2: Tạo bản version mới
    const [newVersion] = await tx
      .insert(planningPeriods)
      .values({
        departmentId: old.departmentId,
        section: old.section,
        groupName: old.groupName,
        location: old.location,
        division: old.division,
        startDate: newStartDate,
        endDate: newEndDate,
        status: "ACTIVE",
        version: old.version + 1,
        requestType: old.requestType,
        supplementIndex: old.supplementIndex,
        parentPeriodId: old.parentPeriodId,
        createdBy: revisedBy,
      })
      .returning();

    // BƯỚC 3: Bản cũ trỏ tới bản mới
    await tx.update(planningPeriods).set({ supersededBy: newVersion.id }).where(eq(planningPeriods.id, old.id));

    // BƯỚC 4: Target mới + chuyển các allocations sang version mới
    await tx.insert(planningTargets).values({
      planningPeriodId: newVersion.id,
      demandMale,
      demandFemale,
      targetCount,
      note: input.note ?? oldTarget?.note ?? null,
    });
    /* Yêu cầu #4 & #8 — LỊCH SỬ CHỈ THÊM, KHÔNG GHI ĐÈ.
       Trước đây dòng phân bổ bị UPDATE sang planning_period_id mới, nên bản
       kế hoạch cũ mất sạch dấu vết ai đã từng được phân bổ vào nó. Nay ta
       ĐÓNG phân bổ cũ (allocation_end_date) rồi MỞ phân bổ mới trỏ tới bản
       version mới, nối chuỗi qua previous_allocation_id.
       LƯU Ý: đóng phân bổ KHÔNG phải nghỉ việc — không đụng employment_sessions
       hay workforce_movements (Yêu cầu #9). */
    const openAllocs = await tx
      .select({
        id: planningAllocations.id,
        employmentSessionId: planningAllocations.employmentSessionId,
        allocationStartDate: planningAllocations.allocationStartDate,
        recruitmentRequestId: planningAllocations.recruitmentRequestId,
      })
      .from(planningAllocations)
      .where(
        and(
          eq(planningAllocations.planningPeriodId, old.id),
          isNull(planningAllocations.allocationEndDate),
        ),
      )
      .for("update");

    const today = todayStr();
    for (const alloc of openAllocs) {
      await tx
        .update(planningAllocations)
        .set({ allocationEndDate: today, reallocatedBy: revisedBy, reallocatedAt: new Date() })
        .where(eq(planningAllocations.id, alloc.id));

      await tx
        .insert(planningAllocations)
        .values({
          employmentSessionId: alloc.employmentSessionId,
          planningPeriodId: newVersion.id,
          recruitmentRequestId: alloc.recruitmentRequestId,
          allocationStartDate: alloc.allocationStartDate ?? today,
          previousAllocationId: alloc.id,
          allocatedBy: revisedBy,
        })
        .onConflictDoNothing();
    }

    return newVersion;
  });
}

/**
 * Tự động phân bổ người tập nghề vào kế hoạch ACTIVE phù hợp khi Recruiter duyệt / xếp việc.
 * Quy tắc ưu tiên khi có nhiều kế hoạch trùng:
 *   1. Ưu tiên kế hoạch GỐC (ORIGINAL, supplementIndex = 0) trước nếu còn chỉ tiêu theo giới tính.
 *   2. Sau đó ưu tiên kế hoạch BỔ SUNG theo thứ tự (Bổ sung 1, Bổ sung 2...).
 *   3. Nếu tất cả đã đủ chỉ tiêu, gán vào kế hoạch active mới nhất.
 */
export async function autoAllocateInternship(
  employmentSessionId: string,
  departmentId: string,
  startingDate?: string | null,
  allocatedBy = "SYSTEM",
  executor: Executor = db,
) {
  // Tìm các kế hoạch ACTIVE của bộ phận này
  const activePeriods = await executor
    .select({
      id: planningPeriods.id,
      requestId: planningPeriods.requestId,
      startDate: planningPeriods.startDate,
      endDate: planningPeriods.endDate,
      requestType: planningPeriods.requestType,
      supplementIndex: planningPeriods.supplementIndex,
      demandMale: planningTargets.demandMale,
      demandFemale: planningTargets.demandFemale,
      targetCount: planningTargets.targetCount,
    })
    .from(planningPeriods)
    .leftJoin(planningTargets, eq(planningTargets.planningPeriodId, planningPeriods.id))
    .where(
      and(
        eq(planningPeriods.departmentId, departmentId),
        eq(planningPeriods.status, "ACTIVE"),
      ),
    )
    .orderBy(
      // ORIGINAL trước (supplementIndex = 0), sau đó SUPPLEMENT 1, 2...
      planningPeriods.supplementIndex,
      planningPeriods.createdAt,
    );

  if (activePeriods.length === 0) return null;

  // Lọc theo date range nếu có startingDate
  const matchingDatePeriods = startingDate
    ? activePeriods.filter((p) => p.startDate <= startingDate && p.endDate >= startingDate)
    : activePeriods;

  const candidatePeriods = matchingDatePeriods.length > 0 ? matchingDatePeriods : activePeriods;

  // Lấy giới tính của người tập nghề
  const [session] = await executor
    .select({
      workerId: employmentSessions.workerId,
      gender: workerProfiles.gender,
    })
    .from(employmentSessions)
    .leftJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .where(eq(employmentSessions.id, employmentSessionId));

  const gender = session?.gender ?? null;
  const isTargetFemale = isFemale(gender);
  const isTargetMale = isMale(gender);

  // Tính số đã phân bổ của từng kế hoạch ứng viên
  const periodIds = candidatePeriods.map((p) => p.id);
  const allocations = await executor
    .select({
      planningPeriodId: planningAllocations.planningPeriodId,
      gender: workerProfiles.gender,
    })
    .from(planningAllocations)
    .innerJoin(employmentSessions, eq(planningAllocations.employmentSessionId, employmentSessions.id))
    .leftJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .where(
      and(
        inArray(planningAllocations.planningPeriodId, periodIds),
        // Chỉ đếm phân bổ ĐANG mở — dòng lịch sử đã đóng không được tính hai lần.
        isNull(planningAllocations.allocationEndDate),
        eq(employmentSessions.status, "APPROVED"),
        isNull(employmentSessions.endDate),
      ),
    );

  const allocCounts = new Map<string, { male: number; female: number; total: number }>();
  for (const pid of periodIds) {
    allocCounts.set(pid, { male: 0, female: 0, total: 0 });
  }
  for (const a of allocations) {
    const current = allocCounts.get(a.planningPeriodId);
    if (current) {
      current.total += 1;
      if (isFemale(a.gender)) current.female += 1;
      else if (isMale(a.gender)) current.male += 1;
    }
  }

  // Tìm kế hoạch đầu tiên còn chỗ cho giới tính này
  let chosenPeriodId = candidatePeriods[0].id;
  for (const p of candidatePeriods) {
    const alloc = allocCounts.get(p.id) ?? { male: 0, female: 0, total: 0 };
    const maleDemand = p.demandMale ?? 0;
    const femaleDemand = p.demandFemale ?? 0;
    const totalDemand = (maleDemand + femaleDemand > 0) ? (maleDemand + femaleDemand) : (p.targetCount ?? 0);

    if (isTargetFemale && femaleDemand > 0 && alloc.female < femaleDemand) {
      chosenPeriodId = p.id;
      break;
    } else if (isTargetMale && maleDemand > 0 && alloc.male < maleDemand) {
      chosenPeriodId = p.id;
      break;
    } else if (!isTargetFemale && !isTargetMale && alloc.total < totalDemand) {
      chosenPeriodId = p.id;
      break;
    }
  }

  /* Yêu cầu #4 — trước đây phân bổ cũ bị DELETE, xoá luôn lịch sử. Nay ta
     ĐÓNG nó lại: dòng cũ vẫn truy vết được, dòng mới nối qua
     previous_allocation_id. Nếu người này đã ở đúng kế hoạch đích rồi thì
     không làm gì cả (idempotent). */
  const today = todayStr();
  const existing = await executor
    .select({
      id: planningAllocations.id,
      planningPeriodId: planningAllocations.planningPeriodId,
      allocationStartDate: planningAllocations.allocationStartDate,
    })
    .from(planningAllocations)
    .where(
      and(
        eq(planningAllocations.employmentSessionId, employmentSessionId),
        isNull(planningAllocations.allocationEndDate),
      ),
    );

  if (existing.some((a) => a.planningPeriodId === chosenPeriodId)) return chosenPeriodId;

  let previousAllocationId: string | null = null;
  for (const alloc of existing) {
    await executor
      .update(planningAllocations)
      .set({ allocationEndDate: today, reallocatedBy: allocatedBy, reallocatedAt: new Date() })
      .where(eq(planningAllocations.id, alloc.id));
    previousAllocationId = alloc.id;
  }

  await executor
    .insert(planningAllocations)
    .values({
      employmentSessionId,
      planningPeriodId: chosenPeriodId,
      allocationStartDate: startingDate ?? today,
      previousAllocationId,
      allocatedBy,
    })
    .onConflictDoNothing();

  // WORKFORCE REQUEST LINKAGE (mục 8 + 9): nếu kế hoạch được chọn CÓ liên kết
  // Workforce Request (planning_periods.request_id) → mirror sang request_allocations
  // để Request vẫn là source of truth. Tôn trọng quy tắc chặn vượt tổng nhu cầu
  // (không tự override) — nếu request đã đủ thì giữ nguyên allocation planning legacy.
  const chosenPeriod = candidatePeriods.find((p) => p.id === chosenPeriodId);
  if (chosenPeriod?.requestId && session?.workerId) {
    await mirrorPlanningAllocationToRequest({
      planningPeriodId: chosenPeriod.id,
      employmentSessionId,
      workerId: session.workerId,
      allocatedBy,
      reason: "Tự động phân bổ khi duyệt hồ sơ / chuyển bộ phận",
      executor,
    });
  }

  return chosenPeriodId;
}

/** Danh sách employment_sessions ĐANG LÀM nhưng chưa được phân bổ vào kế hoạch ACTIVE nào. */
export async function getUnplannedSessions(departmentIds?: string[]) {
  const allocatedToActive = await db
    .select({ sessionId: planningAllocations.employmentSessionId })
    .from(planningAllocations)
    .innerJoin(planningPeriods, eq(planningAllocations.planningPeriodId, planningPeriods.id))
    .where(and(eq(planningPeriods.status, "ACTIVE"), isNull(planningAllocations.allocationEndDate)));
  const allocatedIds = allocatedToActive.map((r) => r.sessionId);

  const filters = [
    eq(employmentSessions.status, "APPROVED"),
    isNull(employmentSessions.endDate),
    isNull(workerProfiles.deletedAt),
    or(isNull(employmentSessions.startingDate), lte(employmentSessions.startingDate, todayStr()))!,
  ];
  if (departmentIds) {
    if (departmentIds.length === 0) return [];
    filters.push(inArray(employmentSessions.deptId, departmentIds));
  }
  if (allocatedIds.length > 0) filters.push(notInArray(employmentSessions.id, allocatedIds));

  const rows = await db
    .select({
      id: employmentSessions.id,
      workerId: employmentSessions.workerId,
      workerName: workerProfiles.fullName,
      workerCccd: workerProfiles.cccd,
      gender: workerProfiles.gender,
      deptId: employmentSessions.deptId,
      deptName: departments.deptName,
      regDate: employmentSessions.regDate,
    })
    .from(employmentSessions)
    .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
    .where(and(...filters));

  // Chuẩn hoá họ tên lao động trước khi trả về UI.
  return rows.map((r) => ({ ...r, workerName: normalizePersonName(r.workerName ?? "") || null }));
}

/**
 * Tổng hợp toàn bộ chỉ số cho danh sách Kế hoạch Tập nghề theo batch (Không N+1 query).
 *
 * CÔNG THỨC:
 *   - Cần tuyển Nam = Nhu cầu cần Nam - Phân bổ Nam + Nghỉ việc Nam (clamp về 0)
 *   - Cần tuyển Nữ = Nhu cầu cần Nữ - Phân bổ Nữ + Nghỉ việc Nữ (clamp về 0)
 *   - Tổng cần tuyển = Cần tuyển Nam + Cần tuyển Nữ
 */
export async function batchComputePlanningMetrics(periodIds: string[]): Promise<Map<string, PlanningMetrics>> {
  const result = new Map<string, PlanningMetrics>();
  if (periodIds.length === 0) return result;

  // 1. Lấy targets
  const targets = await db
    .select({
      planningPeriodId: planningTargets.planningPeriodId,
      demandMale: planningTargets.demandMale,
      demandFemale: planningTargets.demandFemale,
      targetCount: planningTargets.targetCount,
    })
    .from(planningTargets)
    .where(inArray(planningTargets.planningPeriodId, periodIds));

  const targetMap = new Map(targets.map((t) => [t.planningPeriodId, t]));

  // 2. Lấy allocations đang active (APPROVED và chưa kết thúc)
  const allocations = await db
    .select({
      planningPeriodId: planningAllocations.planningPeriodId,
      gender: workerProfiles.gender,
    })
    .from(planningAllocations)
    .innerJoin(employmentSessions, eq(planningAllocations.employmentSessionId, employmentSessions.id))
    .leftJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .where(
      and(
        inArray(planningAllocations.planningPeriodId, periodIds),
        // Chỉ đếm phân bổ ĐANG mở (Yêu cầu #4: lịch sử được giữ nhưng không cộng dồn).
        isNull(planningAllocations.allocationEndDate),
        eq(employmentSessions.status, "APPROVED"),
        isNull(employmentSessions.endDate),
      ),
    );

  const allocCountMap = new Map<string, { male: number; female: number; total: number }>();
  for (const pid of periodIds) {
    allocCountMap.set(pid, { male: 0, female: 0, total: 0 });
  }
  for (const a of allocations) {
    const c = allocCountMap.get(a.planningPeriodId);
    if (c) {
      c.total += 1;
      if (isFemale(a.gender)) c.female += 1;
      else if (isMale(a.gender)) c.male += 1;
    }
  }

  // 3. Lấy số lượng nghỉ việc đã có hiệu lực (RESIGNATION đã duyệt / INACTIVE) của các người thuộc kế hoạch này
  const resignations = await db
    .select({
      planningPeriodId: planningAllocations.planningPeriodId,
      gender: workerProfiles.gender,
    })
    .from(planningAllocations)
    .innerJoin(employmentSessions, eq(planningAllocations.employmentSessionId, employmentSessions.id))
    .leftJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .innerJoin(
      workforceMovements,
      and(
        eq(workforceMovements.workerId, employmentSessions.workerId),
        eq(workforceMovements.movementType, "resignation"),
        eq(workforceMovements.status, "INACTIVE"),
      ),
    )
    .where(
      and(
        inArray(planningAllocations.planningPeriodId, periodIds),
        isNull(planningAllocations.allocationEndDate),
      ),
    );

  const resignCountMap = new Map<string, { male: number; female: number; total: number }>();
  for (const pid of periodIds) {
    resignCountMap.set(pid, { male: 0, female: 0, total: 0 });
  }
  for (const r of resignations) {
    const c = resignCountMap.get(r.planningPeriodId);
    if (c) {
      c.total += 1;
      if (isFemale(r.gender)) c.female += 1;
      else if (isMale(r.gender)) c.male += 1;
    }
  }

  // 4. Tính toán cho từng period
  for (const pid of periodIds) {
    const target = targetMap.get(pid);
    const alloc = allocCountMap.get(pid) ?? { male: 0, female: 0, total: 0 };
    const resign = resignCountMap.get(pid) ?? { male: 0, female: 0, total: 0 };

    const demandMale = target?.demandMale ?? 0;
    const demandFemale = target?.demandFemale ?? 0;
    // Nếu legacy data chưa phân tách nam/nữ, dùng targetCount làm tổng nhu cầu
    const demandTotal = (demandMale + demandFemale > 0)
      ? (demandMale + demandFemale)
      : (target?.targetCount ?? 0);

    const allocatedMale = alloc.male;
    const allocatedFemale = alloc.female;
    const allocatedTotal = alloc.total;

    const resignedMale = resign.male;
    const resignedFemale = resign.female;
    const resignedTotal = resign.total;

    // CÔNG THỨC: Nhu cầu - Phân bổ + Nghỉ việc (clamp về 0 nếu âm)
    // Nghiệp vụ tuyển dụng: Nếu phân bổ vượt nhu cầu, số cần tuyển không được âm.
    const recruitmentNeededMale = Math.max(0, demandMale - allocatedMale + resignedMale);
    const recruitmentNeededFemale = Math.max(0, demandFemale - allocatedFemale + resignedFemale);
    const recruitmentNeededTotal = demandMale + demandFemale > 0
      ? (recruitmentNeededMale + recruitmentNeededFemale)
      : Math.max(0, demandTotal - allocatedTotal + resignedTotal);

    const fillRatePercent = demandTotal > 0
      ? Math.min(100, Math.round((allocatedTotal / demandTotal) * 100))
      : 0;

    result.set(pid, {
      demandMale,
      demandFemale,
      demandTotal,
      allocatedMale,
      allocatedFemale,
      allocatedTotal,
      resignedMale,
      resignedFemale,
      resignedTotal,
      recruitmentNeededMale,
      recruitmentNeededFemale,
      recruitmentNeededTotal,
      fillRatePercent,
    });
  }

  return result;
}

/* ============================================================
   WORKFORCE REQUEST LINKAGE (mục 8) — Planning THEO Workforce Request
   ------------------------------------------------------------
   Khi planning_periods.request_id có liên kết, KPI của Planning
   ĐƯỢC TÍNH TỪ Workforce Request (source of truth) thay vì tự
   tính riêng — tránh 2 nơi ra 2 con số khác nhau. Hàm này ánh xạ
   RequestKpi (công thức chuẩn trong workforce-request-kpi.ts)
   sang hình dạng PlanningMetrics mà UI Planning đang dùng.
   ============================================================ */
export type PlanningMetricsWithSource = PlanningMetrics & {
  /** "linked_request" = số liệu lấy từ Workforce Request; "legacy" = tính theo luồng Planning cũ. */
  metricsSource: "linked_request" | "legacy";
  requestId: string | null;
  warnings: WarningDetail[];
};

export function requestKpiToPlanningMetrics(kpi: RequestKpi, requestId: string): PlanningMetricsWithSource {
  return {
    demandMale: kpi.maleRequest,
    demandFemale: kpi.femaleRequest,
    demandTotal: kpi.totalRequest,
    allocatedMale: kpi.maleCurrent,
    allocatedFemale: kpi.femaleCurrent,
    allocatedTotal: kpi.totalCurrent,
    resignedMale: kpi.maleQuit,
    resignedFemale: kpi.femaleQuit,
    resignedTotal: kpi.totalQuit,
    recruitmentNeededMale: kpi.maleBalance,
    recruitmentNeededFemale: kpi.femaleBalance,
    recruitmentNeededTotal: kpi.totalBalance,
    fillRatePercent: kpi.fillRatePercent,
    metricsSource: "linked_request",
    requestId,
    warnings: kpi.warnings,
  };
}

export function legacyPlanningMetrics(metrics: PlanningMetrics, requestId: string | null): PlanningMetricsWithSource {
  return { ...metrics, metricsSource: "legacy", requestId, warnings: [] };
}
