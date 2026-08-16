import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  planningAllocations,
  planningPeriods,
  planningTargets,
  recruitmentRequests,
  requestAllocationHistory,
  requestAllocations,
  employmentSessions,
  workerProfiles,
} from "@/db/schema";
import { todayStr } from "@/lib/helpers";
import { computeRecruitmentBalance } from "@/lib/workforce-request-kpi";
import { countActiveDepartmentWorkforce, countQuitDuringRequest, resolveRequestQuitWindow } from "@/lib/recruitment-kpi";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/* ============================================================
   PROVISION RECRUITMENT REQUEST — luồng Import / Create (mục C-H)
   ------------------------------------------------------------
   Gọi SAU KHI đã insert/update xong recruitment_requests (cần
   request.id có sẵn). Thực hiện, theo đúng thứ tự nghiệp vụ:

     1. SNAPSHOT current workforce tại thời điểm mở request — CHỈ MỘT LẦN
        (guard bằng snapshot_at IS NULL). Import lại cùng Request Code
        KHÔNG reset snapshot.
     2. Tính Quit During Request LIVE + recompute Balance = max(0, Rq −
        Snapshot + Quit) — KHÔNG BAO GIỜ dùng Current realtime ở đây.
     3. AUTO-LINK Planning Period (tạo nếu chưa có — idempotent) + Planning
        Target (upsert theo planning_period_id — idempotent).
     4. AUTO-ALLOCATE toàn bộ ACTIVE Employment Session của Department CHƯA
        có ACTIVE request allocation ở BẤT KỲ request nào (mục H — không tự
        chuyển worker đã thuộc request khác).

   Toàn bộ bước đều IDEMPOTENT: gọi lại nhiều lần (import trùng, retry,
   double-click, PATCH không đổi gì) không tạo dữ liệu trùng và không phá
   snapshot lịch sử.
   ============================================================ */
export type ProvisionRecruitmentRequestInput = {
  requestId: string;
  departmentId: string | null;
  maleRq: number;
  femaleRq: number;
  location: string | null;
  division: string | null;
  section: string | null;
  groupName: string | null;
  startingDate: string | null;
  expectedDate: string | null;
  requestedDate: string | null;
  endDate: string | null;
  /** Status hiện tại của request — quyết định Planning Period tạo mới ACTIVE hay DRAFT. */
  status: string;
  actor: string;
};

export async function provisionRecruitmentRequest(
  executor: Executor,
  input: ProvisionRecruitmentRequestInput,
): Promise<void> {
  if (!input.departmentId) {
    // Không khớp được Department — không có gì để snapshot/auto-link/auto-allocate.
    // Balance = Rq (không có Current nào để trừ), khớp hành vi trước đây.
    const balance = computeRecruitmentBalance({
      maleRequest: input.maleRq,
      femaleRequest: input.femaleRq,
      maleCurrentAtStart: 0,
      femaleCurrentAtStart: 0,
      maleQuitDuringRequest: 0,
      femaleQuitDuringRequest: 0,
    });
    await executor
      .update(recruitmentRequests)
      .set({
        maleBalance: balance.maleBalance,
        femaleBalance: balance.femaleBalance,
        totalBalance: balance.totalBalance,
        updatedAt: new Date(),
      })
      .where(eq(recruitmentRequests.id, input.requestId));
    return;
  }

  /* ---- 1) SNAPSHOT (chỉ 1 lần — guard snapshot_at IS NULL) ------------ */
  const [existing] = await executor
    .select({
      snapshotAt: recruitmentRequests.snapshotAt,
      maleCurrentAtStart: recruitmentRequests.maleCurrentAtStart,
      femaleCurrentAtStart: recruitmentRequests.femaleCurrentAtStart,
      totalCurrentAtStart: recruitmentRequests.totalCurrentAtStart,
      planningPeriodId: recruitmentRequests.planningPeriodId,
    })
    .from(recruitmentRequests)
    .where(eq(recruitmentRequests.id, input.requestId));

  let maleCurrentAtStart = existing?.maleCurrentAtStart ?? 0;
  let femaleCurrentAtStart = existing?.femaleCurrentAtStart ?? 0;
  let totalCurrentAtStart = existing?.totalCurrentAtStart ?? 0;
  let planningPeriodId = existing?.planningPeriodId ?? null;

  if (!existing?.snapshotAt) {
    const snapshot = await countActiveDepartmentWorkforce(executor, input.departmentId);
    maleCurrentAtStart = snapshot.male;
    femaleCurrentAtStart = snapshot.female;
    totalCurrentAtStart = snapshot.total;
    // Guard kép: snapshot_at IS NULL trong WHERE — nếu 2 request đồng thời
    // cùng cố snapshot (race), chỉ lần đầu ghi được, lần sau no-op.
    await executor
      .update(recruitmentRequests)
      .set({
        maleCurrentAtStart,
        femaleCurrentAtStart,
        totalCurrentAtStart,
        snapshotAt: new Date(),
      })
      .where(and(eq(recruitmentRequests.id, input.requestId), isNull(recruitmentRequests.snapshotAt)));
  }

  /* ---- 2) QUIT DURING REQUEST (live) + RECOMPUTE BALANCE -------------- */
  const window = resolveRequestQuitWindow({
    startingDate: input.startingDate,
    expectedDate: input.expectedDate,
    requestedDate: input.requestedDate,
    endDate: input.endDate,
    createdAt: new Date(),
  });
  const quit = await countQuitDuringRequest(executor, input.departmentId, window);
  const balance = computeRecruitmentBalance({
    maleRequest: input.maleRq,
    femaleRequest: input.femaleRq,
    maleCurrentAtStart,
    femaleCurrentAtStart,
    maleQuitDuringRequest: quit.male,
    femaleQuitDuringRequest: quit.female,
  });
  await executor
    .update(recruitmentRequests)
    .set({
      maleBalance: balance.maleBalance,
      femaleBalance: balance.femaleBalance,
      totalBalance: balance.totalBalance,
      updatedAt: new Date(),
    })
    .where(eq(recruitmentRequests.id, input.requestId));

  /* ---- 3) AUTO-LINK PLANNING PERIOD (tạo nếu chưa có) ------------------ */
  if (!planningPeriodId) {
    const startDate = input.startingDate ?? input.expectedDate ?? input.requestedDate ?? todayStr();
    const endDate = input.endDate ?? startDate;
    const [period] = await executor
      .insert(planningPeriods)
      .values({
        departmentId: input.departmentId,
        section: input.section,
        groupName: input.groupName,
        location: input.location,
        division: input.division,
        startDate,
        endDate,
        status: input.status === "PENDING" || input.status === "PROCESSING" ? "ACTIVE" : "DRAFT",
        version: 1,
        requestType: "ORIGINAL",
        supplementIndex: 0,
        requestId: input.requestId,
        createdBy: input.actor,
      })
      .returning({ id: planningPeriods.id });
    planningPeriodId = period.id;
    await executor
      .update(recruitmentRequests)
      .set({ planningPeriodId, updatedAt: new Date() })
      .where(eq(recruitmentRequests.id, input.requestId));
  }

  /* ---- PLANNING TARGET (idempotent upsert theo planning_period_id) ---- */
  const targetCount = Math.max(0, input.maleRq) + Math.max(0, input.femaleRq);
  await executor
    .insert(planningTargets)
    .values({
      planningPeriodId,
      demandMale: Math.max(0, input.maleRq),
      demandFemale: Math.max(0, input.femaleRq),
      targetCount,
    })
    .onConflictDoUpdate({
      target: planningTargets.planningPeriodId,
      set: {
        demandMale: Math.max(0, input.maleRq),
        demandFemale: Math.max(0, input.femaleRq),
        targetCount,
      },
    });

  /* ---- 4) AUTO-ALLOCATE department workforce (idempotent) ------------- */
  await autoAllocateDepartmentWorkforce(executor, {
    requestId: input.requestId,
    departmentId: input.departmentId,
    planningPeriodId,
    actor: input.actor,
  });
}

/**
 * Phân bổ TOÀN BỘ ACTIVE Employment Session của Department vào request này,
 * NGOẠI TRỪ worker đã có ACTIVE request allocation (ở BẤT KỲ request nào —
 * mục H: không tự chuyển/tự reallocate worker đã thuộc request khác).
 * Idempotent: unique index request_alloc_one_active_per_worker_uq +
 * planning_alloc_active_uq + onConflictDoNothing chống double-click/retry.
 */
async function autoAllocateDepartmentWorkforce(
  executor: Executor,
  input: { requestId: string; departmentId: string; planningPeriodId: string | null; actor: string },
): Promise<number> {
  const candidates = await executor
    .select({
      sessionId: employmentSessions.id,
      workerId: employmentSessions.workerId,
    })
    .from(employmentSessions)
    .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .leftJoin(
      requestAllocations,
      and(eq(requestAllocations.workerId, employmentSessions.workerId), eq(requestAllocations.status, "ACTIVE")),
    )
    .where(
      and(
        eq(employmentSessions.deptId, input.departmentId),
        eq(employmentSessions.status, "APPROVED"),
        isNull(employmentSessions.endDate),
        isNull(workerProfiles.deletedAt),
        // Worker CHƯA có ACTIVE allocation ở bất kỳ request nào.
        isNull(requestAllocations.id),
      ),
    );

  let allocated = 0;
  for (const c of candidates) {
    const inserted = await executor
      .insert(requestAllocations)
      .values({
        employmentSessionId: c.sessionId,
        workerId: c.workerId,
        requestId: input.requestId,
        status: "ACTIVE",
        allocatedBy: input.actor,
      })
      .onConflictDoNothing({
        target: requestAllocations.workerId,
        where: sql`status = 'ACTIVE'`,
      })
      .returning({ id: requestAllocations.id });

    // Race: worker vừa được allocation khác chiếm giữ giữa lúc query & insert.
    // Không tự END/reallocate — giữ nguyên (mục H), bỏ qua worker này.
    if (inserted.length === 0) continue;

    await executor.insert(requestAllocationHistory).values({
      requestId: input.requestId,
      workerId: c.workerId,
      employmentSessionId: c.sessionId,
      fromRequestId: null,
      toRequestId: input.requestId,
      action: "ALLOCATE",
      reason: "Tự động phân bổ ACTIVE workforce theo Department khi tạo/import Workforce Request",
      changedBy: input.actor,
    });

    if (input.planningPeriodId) {
      await executor
        .insert(planningAllocations)
        .values({
          employmentSessionId: c.sessionId,
          planningPeriodId: input.planningPeriodId,
          recruitmentRequestId: input.requestId,
          allocationStartDate: todayStr(),
          allocatedBy: input.actor,
        })
        .onConflictDoNothing();
    }

    allocated += 1;
  }

  return allocated;
}
