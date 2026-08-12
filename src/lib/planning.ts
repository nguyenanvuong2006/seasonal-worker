import "server-only";
import { and, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, employmentSessions, planningAllocations, planningPeriods, planningTargets, workerProfiles } from "@/db/schema";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * PLANNING (Phase 2, Step 4) — thay departments.dailyQuota (deprecated, xem Bước A ở #7
 * "dọn dẹp") bằng kế hoạch theo GIAI ĐOẠN, có version, không cho overlap.
 * `section` = departments.groupName tại thời điểm tạo (đã xác nhận dùng lại groupName,
 * không tạo bảng sections riêng).
 */

/** Kiểm tra chồng lấn ngày với các kế hoạch ACTIVE cùng Department+Section. */
export async function checkOverlap(
  departmentId: string,
  section: string | null,
  startDate: string,
  endDate: string,
  excludePeriodId?: string,
  executor: Executor = db,
) {
  const filters = [
    eq(planningPeriods.departmentId, departmentId),
    eq(planningPeriods.status, "ACTIVE"),
    // overlap nếu KHÔNG (kết thúc mới < bắt đầu cũ HOẶC bắt đầu mới > kết thúc cũ)
    sql`NOT (${endDate}::date < ${planningPeriods.startDate} OR ${startDate}::date > ${planningPeriods.endDate})`,
  ];
  if (section) filters.push(eq(planningPeriods.section, section));
  else filters.push(isNull(planningPeriods.section));
  if (excludePeriodId) filters.push(ne(planningPeriods.id, excludePeriodId));

  return executor.select().from(planningPeriods).where(and(...filters));
}

export async function createPeriod(input: {
  departmentId: string;
  section: string | null;
  startDate: string;
  endDate: string;
  targetCount: number;
  note?: string;
  createdBy: string;
  activateNow: boolean;
}) {
  if (input.startDate > input.endDate) throw new Error("Ngày bắt đầu phải trước ngày kết thúc.");
  if (input.activateNow) {
    const overlaps = await checkOverlap(input.departmentId, input.section, input.startDate, input.endDate);
    if (overlaps.length > 0) {
      throw new Error(
        `Chồng lấn thời gian với kế hoạch đang ACTIVE (${overlaps[0].startDate} → ${overlaps[0].endDate}). Vui lòng chọn khoảng ngày khác hoặc kích hoạt sau khi kế hoạch cũ hết hạn.`,
      );
    }
  }

  const [period] = await db
    .insert(planningPeriods)
    .values({
      departmentId: input.departmentId,
      section: input.section,
      startDate: input.startDate,
      endDate: input.endDate,
      status: input.activateNow ? "ACTIVE" : "DRAFT",
      version: 1,
      createdBy: input.createdBy,
    })
    .returning();

  await db.insert(planningTargets).values({ planningPeriodId: period.id, targetCount: input.targetCount, note: input.note ?? null });
  return period;
}

/** Kích hoạt 1 kế hoạch DRAFT — kiểm tra overlap tại thời điểm kích hoạt. */
export async function activatePeriod(periodId: string) {
  const [period] = await db.select().from(planningPeriods).where(eq(planningPeriods.id, periodId));
  if (!period) throw new Error("Không tìm thấy kế hoạch.");
  if (period.status !== "DRAFT") throw new Error("Chỉ có thể kích hoạt kế hoạch đang ở trạng thái Draft.");

  const overlaps = await checkOverlap(period.departmentId, period.section, period.startDate, period.endDate, period.id);
  if (overlaps.length > 0) {
    throw new Error(`Chồng lấn thời gian với kế hoạch đang ACTIVE khác. Không thể kích hoạt.`);
  }
  const [updated] = await db.update(planningPeriods).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(planningPeriods.id, periodId)).returning();
  return updated;
}

/**
 * Sửa 1 kế hoạch ACTIVE = tạo bản ghi VERSION MỚI (giữ nguyên bản cũ, không UPDATE đè —
 * đúng yêu cầu "Không được mất lịch sử"). Bản cũ được đánh dấu supersededBy trỏ tới bản mới.
 *
 * P0-5 (Production Hardening Audit) — TRƯỚC ĐÂY: (1) insert bản mới ACTIVE trong khi bản cũ
 * VẪN ACTIVE → đụng thẳng unique partial index `planning_active_dept_section_uq`
 * (departmentId, section) WHERE status='ACTIVE' (2 bản ACTIVE cùng dept+section cùng lúc);
 * (2) các bước insert/update rời rạc không transaction — 1 bước fail giữa chừng để lại DB ở
 * trạng thái dở dang (có thể 0 hoặc 2 bản ACTIVE, allocations trỏ sai version). Nay: toàn bộ
 * chạy trong 1 transaction (rollback hết nếu bất kỳ bước nào lỗi), và LUÔN hết hạn bản cũ
 * TRƯỚC khi insert bản mới ACTIVE (giải phóng đúng "chỗ trống" mà unique index yêu cầu) — khoá
 * dòng bản cũ bằng SELECT ... FOR UPDATE để chặn 2 lần revise cùng lúc trên cùng 1 kế hoạch.
 */
export async function reviseActivePeriod(
  periodId: string,
  input: { startDate?: string; endDate?: string; targetCount?: number; note?: string },
  revisedBy: string,
) {
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(planningPeriods).where(eq(planningPeriods.id, periodId)).for("update");
    if (!old) throw new Error("Không tìm thấy kế hoạch.");
    if (old.status !== "ACTIVE") throw new Error("Chỉ sửa được kế hoạch đang ACTIVE (kế hoạch Draft có thể sửa trực tiếp, Expired thì tạo kế hoạch mới).");

    const newStartDate = input.startDate ?? old.startDate;
    const newEndDate = input.endDate ?? old.endDate;

    const overlaps = await checkOverlap(old.departmentId, old.section, newStartDate, newEndDate, old.id, tx);
    if (overlaps.length > 0) {
      throw new Error(`Khoảng ngày mới chồng lấn với kế hoạch ACTIVE khác.`);
    }

    const [oldTarget] = await tx.select().from(planningTargets).where(eq(planningTargets.planningPeriodId, old.id));

    // BƯỚC 1 — hết hạn bản cũ TRƯỚC, giải phóng "chỗ trống" ACTIVE cho dept+section này.
    await tx.update(planningPeriods).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(planningPeriods.id, old.id));

    // BƯỚC 2 — tạo bản mới ACTIVE (an toàn với unique index vì bản cũ đã EXPIRED ở trên, CÙNG transaction).
    const [newVersion] = await tx
      .insert(planningPeriods)
      .values({
        departmentId: old.departmentId,
        section: old.section,
        startDate: newStartDate,
        endDate: newEndDate,
        status: "ACTIVE",
        version: old.version + 1,
        createdBy: revisedBy,
      })
      .returning();

    // BƯỚC 3 — gắn supersededBy trên bản cũ trỏ đúng sang bản mới vừa tạo.
    await tx.update(planningPeriods).set({ supersededBy: newVersion.id }).where(eq(planningPeriods.id, old.id));

    // BƯỚC 4 — target mới + chuyển toàn bộ phân bổ (allocations) sang version mới, không mất liên kết lao động đã gán.
    await tx.insert(planningTargets).values({
      planningPeriodId: newVersion.id,
      targetCount: input.targetCount ?? oldTarget?.targetCount ?? 0,
      note: input.note ?? oldTarget?.note ?? null,
    });
    await tx.update(planningAllocations).set({ planningPeriodId: newVersion.id }).where(eq(planningAllocations.planningPeriodId, old.id));

    return newVersion;
  });
}

/** Danh sách employment_sessions ĐANG LÀM (chưa kết thúc) nhưng chưa được phân bổ vào kế hoạch ACTIVE nào. */
export async function getUnplannedSessions(departmentId?: string) {
  const allocatedToActive = await db
    .select({ sessionId: planningAllocations.employmentSessionId })
    .from(planningAllocations)
    .innerJoin(planningPeriods, eq(planningAllocations.planningPeriodId, planningPeriods.id))
    .where(eq(planningPeriods.status, "ACTIVE"));
  const allocatedIds = allocatedToActive.map((r) => r.sessionId);

  const filters = [eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate)];
  if (departmentId) filters.push(eq(employmentSessions.deptId, departmentId));
  if (allocatedIds.length > 0) filters.push(notInArray(employmentSessions.id, allocatedIds));

  return db
    .select({
      id: employmentSessions.id,
      workerId: employmentSessions.workerId,
      workerName: workerProfiles.fullName,
      workerCccd: workerProfiles.cccd,
      deptId: employmentSessions.deptId,
      deptName: departments.deptName,
      regDate: employmentSessions.regDate,
    })
    .from(employmentSessions)
    .leftJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
    .where(and(...filters));
}

/** Tỷ lệ lấp đầy — ACTIVE (đã phân bổ + đang APPROVED) / Nhu cầu Planning đang Active. */
export async function computeFillRate(periodId: string) {
  const [target] = await db.select().from(planningTargets).where(eq(planningTargets.planningPeriodId, periodId));
  const allocated = await db
    .select({ sessionId: planningAllocations.employmentSessionId })
    .from(planningAllocations)
    .innerJoin(employmentSessions, eq(planningAllocations.employmentSessionId, employmentSessions.id))
    .where(and(eq(planningAllocations.planningPeriodId, periodId), eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate)));

  const demand = target?.targetCount ?? 0;
  const active = allocated.length;
  return { demand, active, missing: Math.max(0, demand - active), percent: demand > 0 ? Math.round((active / demand) * 100) : 0 };
}
