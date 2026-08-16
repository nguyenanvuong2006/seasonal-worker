import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions, recruitmentRequests, workforceMovements, workerProfiles } from "@/db/schema";
import { isFemale, isMale, todayStr } from "@/lib/helpers";
import {
  computeRecruitmentBalance,
  reconcileRecruitmentKpis,
  type RecruitmentKpiSnapshotResult,
} from "@/lib/workforce-request-kpi";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/* ============================================================
   CANONICAL KPI SERVICE — computeRecruitmentKpis(requestId)
   ------------------------------------------------------------
   Nguồn sự thật DUY NHẤT cho Recruitment Balance vs Realtime Gap
   (mục J của đề bài). Mọi nơi hiển thị 2 KPI này (API, dashboard,
   Task Center) PHẢI gọi qua đây — không tự viết lại công thức.
   ============================================================ */

export type DepartmentWorkforceCount = { male: number; female: number; total: number };

/** ACTIVE worker theo Department (mục A.1): APPROVED + end_date NULL + worker chưa xoá. */
export async function countActiveDepartmentWorkforce(
  executor: Executor,
  departmentId: string,
): Promise<DepartmentWorkforceCount> {
  const rows = await executor
    .select({ gender: workerProfiles.gender })
    .from(employmentSessions)
    .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .where(
      and(
        eq(employmentSessions.deptId, departmentId),
        eq(employmentSessions.status, "APPROVED"),
        isNull(employmentSessions.endDate),
        isNull(workerProfiles.deletedAt),
      ),
    );
  const male = rows.filter((r) => isMale(r.gender)).length;
  const female = rows.filter((r) => isFemale(r.gender)).length;
  return { male, female, total: rows.length };
}

/**
 * Khoảng thời gian "During Request" (mục 2): ưu tiên starting_date, fallback
 * expected_date, fallback requested_date. Kết thúc = end_date (nếu chưa hết
 * hạn thì tạm dùng hôm nay — yêu cầu vẫn đang mở, cửa sổ Quit vẫn tiếp diễn).
 */
export function resolveRequestQuitWindow(request: {
  startingDate: string | null;
  expectedDate: string | null;
  requestedDate: string | null;
  endDate: string | null;
  createdAt: Date;
}): { start: string; end: string } {
  const start =
    request.startingDate ?? request.expectedDate ?? request.requestedDate ?? request.createdAt.toISOString().slice(0, 10);
  const end = request.endDate ?? todayStr();
  return { start, end };
}

/** Quit During Request (mục 2): RESIGNATION đã xác nhận, khớp Department qua session bị đóng. */
export async function countQuitDuringRequest(
  executor: Executor,
  departmentId: string,
  window: { start: string; end: string },
): Promise<DepartmentWorkforceCount> {
  const rows = await executor
    .select({ gender: workerProfiles.gender })
    .from(workforceMovements)
    .innerJoin(employmentSessions, eq(workforceMovements.employmentSessionId, employmentSessions.id))
    .innerJoin(workerProfiles, eq(workforceMovements.workerId, workerProfiles.id))
    .where(
      and(
        eq(employmentSessions.deptId, departmentId),
        sql`lower(${workforceMovements.movementType}) = 'resignation'`,
        eq(workforceMovements.status, "INACTIVE"),
        sql`${workforceMovements.effectiveDate} >= ${window.start}`,
        sql`${workforceMovements.effectiveDate} <= ${window.end}`,
      ),
    );
  const male = rows.filter((r) => isMale(r.gender)).length;
  const female = rows.filter((r) => isFemale(r.gender)).length;
  return { male, female, total: rows.length };
}

export type RecruitmentKpiResult = RecruitmentKpiSnapshotResult & {
  requestId: string;
  maleRequest: number;
  femaleRequest: number;
  maleCurrentAtStart: number;
  femaleCurrentAtStart: number;
  maleQuitDuringRequest: number;
  femaleQuitDuringRequest: number;
  maleCurrentNow: number;
  femaleCurrentNow: number;
  snapshotAt: string | null;
  departmentId: string | null;
};

/**
 * Canonical service — nguồn sự thật DUY NHẤT cho Recruitment Balance vs
 * Realtime Gap của 1 Request (mục J). Trả về null nếu không tìm thấy / đã xoá.
 *
 * Request chưa khớp được department_id: không có gì để đối chiếu — Balance =
 * Rq (snapshot 0), Realtime Gap = Rq (current now 0), reconciliationStatus
 * = OK (0 = 0 khi Rq = 0, ngược lại hai giá trị vẫn bằng nhau vì cùng = Rq).
 */
export async function computeRecruitmentKpis(
  requestId: string,
  executor: Executor = db,
): Promise<RecruitmentKpiResult | null> {
  const [row] = await executor
    .select({
      id: recruitmentRequests.id,
      deletedAt: recruitmentRequests.deletedAt,
      departmentId: recruitmentRequests.departmentId,
      maleRq: recruitmentRequests.maleRq,
      femaleRq: recruitmentRequests.femaleRq,
      maleCurrentAtStart: recruitmentRequests.maleCurrentAtStart,
      femaleCurrentAtStart: recruitmentRequests.femaleCurrentAtStart,
      snapshotAt: recruitmentRequests.snapshotAt,
      startingDate: recruitmentRequests.startingDate,
      expectedDate: recruitmentRequests.expectedDate,
      requestedDate: recruitmentRequests.requestedDate,
      endDate: recruitmentRequests.endDate,
      createdAt: recruitmentRequests.createdAt,
    })
    .from(recruitmentRequests)
    .where(eq(recruitmentRequests.id, requestId));

  if (!row || row.deletedAt) return null;

  let maleQuit = 0;
  let femaleQuit = 0;
  let maleCurrentNow = 0;
  let femaleCurrentNow = 0;

  if (row.departmentId) {
    const window = resolveRequestQuitWindow(row);
    const [quit, currentNow] = await Promise.all([
      countQuitDuringRequest(executor, row.departmentId, window),
      countActiveDepartmentWorkforce(executor, row.departmentId),
    ]);
    maleQuit = quit.male;
    femaleQuit = quit.female;
    maleCurrentNow = currentNow.male;
    femaleCurrentNow = currentNow.female;
  }

  const reconciled = reconcileRecruitmentKpis({
    maleRequest: row.maleRq,
    femaleRequest: row.femaleRq,
    maleCurrentAtStart: row.maleCurrentAtStart,
    femaleCurrentAtStart: row.femaleCurrentAtStart,
    maleQuitDuringRequest: maleQuit,
    femaleQuitDuringRequest: femaleQuit,
    maleCurrentNow,
    femaleCurrentNow,
  });

  return {
    requestId: row.id,
    departmentId: row.departmentId,
    maleRequest: row.maleRq,
    femaleRequest: row.femaleRq,
    maleCurrentAtStart: row.maleCurrentAtStart,
    femaleCurrentAtStart: row.femaleCurrentAtStart,
    maleQuitDuringRequest: maleQuit,
    femaleQuitDuringRequest: femaleQuit,
    maleCurrentNow,
    femaleCurrentNow,
    snapshotAt: row.snapshotAt ? row.snapshotAt.toISOString() : null,
    ...reconciled,
  };
}

/**
 * Trigger recompute KPI cho request (mục I.5) — dùng khi RESIGNATION được
 * confirm (Quit During Request vừa tăng) để cột male_balance/female_balance/
 * total_balance lưu trong DB phản ánh đúng công thức MỚI, không đợi tới lần
 * đọc/PATCH kế tiếp mới đồng bộ. CHỈ ghi lại Balance — KHÔNG đụng snapshot,
 * KHÔNG auto-link Planning, KHÔNG auto-allocate lại (đã có ở luồng tạo/import).
 */
export async function recomputeStoredRecruitmentBalance(executor: Executor, requestId: string): Promise<void> {
  const kpi = await computeRecruitmentKpis(requestId, executor);
  if (!kpi) return;
  const balance = computeRecruitmentBalance({
    maleRequest: kpi.maleRequest,
    femaleRequest: kpi.femaleRequest,
    maleCurrentAtStart: kpi.maleCurrentAtStart,
    femaleCurrentAtStart: kpi.femaleCurrentAtStart,
    maleQuitDuringRequest: kpi.maleQuitDuringRequest,
    femaleQuitDuringRequest: kpi.femaleQuitDuringRequest,
  });
  await executor
    .update(recruitmentRequests)
    .set({
      maleBalance: balance.maleBalance,
      femaleBalance: balance.femaleBalance,
      totalBalance: balance.totalBalance,
      updatedAt: new Date(),
    })
    .where(eq(recruitmentRequests.id, requestId));
}
