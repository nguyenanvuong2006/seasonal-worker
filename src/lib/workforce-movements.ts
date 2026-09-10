import "server-only";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, employmentSessions, workforceMovements } from "@/db/schema";
import { queueNotification } from "@/lib/notifications";
import { autoAllocateInternship } from "@/lib/planning";
import { endActiveRequestAllocationsForWorker } from "@/lib/workforce-request";
import { recomputeStoredRecruitmentBalance } from "@/lib/recruitment-kpi";
import { todayStr } from "@/lib/helpers";
import type { Session } from "@/lib/auth";

/**
 * WORKFORCE MOVEMENT (Phase 2, Step 3) — Nghỉ việc + Thuyên chuyển dùng CHUNG 1 bảng
 * (workforceMovements.movementType phân biệt) theo đúng quyết định đã xác nhận.
 * Trạng thái (status) là 1 stageKey đọc/ghi qua Workflow Engine dùng chung
 * (workflow_stages entityType='resignation'|'transfer') — không hard-code state machine ở đây,
 * chỉ kiểm tra "hành động nào hợp lệ ở trạng thái nào" (đây là RÀNG BUỘC NGHIỆP VỤ, khác với
 * "trạng thái trông như thế nào" — cái sau mới thuộc Workflow Engine).
 *
 * EFFECTIVE-DATE LIFECYCLE (2026-09-10, Worker Lifecycle Consistency audit) — HR "duyệt" (the
 * request decision, confirmedBy/confirmedAt) and the request's downstream WORKFORCE EFFECT
 * (employment session ended / department moved, allocation cleanup, KPI recompute) are now two
 * DISTINCT moments: approving a resignation/transfer effective in the future records the
 * decision immediately but the actual state change is deferred to effectiveDate. See
 * lifecycleAppliedAt on the schema and applyEffectiveWorkforceMovements() below — this is the
 * fix for the reported Production bug ("Bộ phận của tôi" showing an already-past-effective-date
 * approved resignation as still present was actually a SEPARATE, worse defect: that screen read
 * a completely different, never-updated table — see workforce-roster.ts — but auditing it
 * surfaced this real gap too: the canonical employment_sessions state was being mutated
 * IMMEDIATELY at approval regardless of effectiveDate, which would incorrectly drop a
 * future-dated resignation from the active headcount the moment HR approves it).
 */

export type MovementAction =
  | "APPROVE_RESIGNATION" // resignation: PENDING_HR -> INACTIVE
  | "REJECT" // cả 2 loại: PENDING_HR -> REJECTED
  | "CONFIRM_ARRIVED" // transfer: PENDING_HR -> TRANSFER_COMPLETED
  | "RESCHEDULE" // transfer: PENDING_HR -> TRANSFER_RESCHEDULED (cần newEffectiveDate)
  | "NOT_ARRIVED" // transfer: PENDING_HR -> WAITING_DECISION
  | "CANCEL" // transfer: WAITING_DECISION -> CANCELLED
  | "SPAWN_RESIGNATION"; // transfer: WAITING_DECISION -> (giữ nguyên) + sinh 1 resignation mới liên kết

const ALLOWED_ACTIONS: Record<string, Record<string, MovementAction[]>> = {
  resignation: {
    PENDING_HR: ["APPROVE_RESIGNATION", "REJECT"],
  },
  transfer: {
    PENDING_HR: ["CONFIRM_ARRIVED", "RESCHEDULE", "NOT_ARRIVED", "REJECT"],
    TRANSFER_RESCHEDULED: ["CONFIRM_ARRIVED", "RESCHEDULE", "NOT_ARRIVED", "REJECT"],
    WAITING_DECISION: ["CANCEL", "SPAWN_RESIGNATION"],
  },
};

export function isActionAllowed(movementType: string, currentStatus: string, action: MovementAction): boolean {
  return ALLOWED_ACTIONS[movementType]?.[currentStatus]?.includes(action) ?? false;
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// PRODUCTION HARDENING (2026-09-10, defense-in-depth after the Worker 360
// Profile "Lỗi tải hồ sơ" incident): finalizeResignationEffect()/
// finalizeTransferEffect() only ever read this subset of workforceMovements
// columns — every call site below selects EXACTLY this shape (never a blind
// db.select(), which selects every column schema.ts declares and would
// throw for the WHOLE row the moment schema.ts drifts ahead of the real
// Production table on ANY column, not just an unused one).
type MovementForFinalize = {
  id: string;
  movementType: string;
  workerId: string;
  fromDeptId: string | null;
  toDeptId: string | null;
  effectiveDate: string;
  status: string;
  source: string | null;
  note: string | null;
  requestedBy: string;
  lifecycleAppliedAt: Date | null;
  employmentSessionId: string | null;
};

const MOVEMENT_FINALIZE_COLUMNS = {
  id: workforceMovements.id,
  movementType: workforceMovements.movementType,
  workerId: workforceMovements.workerId,
  fromDeptId: workforceMovements.fromDeptId,
  toDeptId: workforceMovements.toDeptId,
  effectiveDate: workforceMovements.effectiveDate,
  status: workforceMovements.status,
  source: workforceMovements.source,
  note: workforceMovements.note,
  requestedBy: workforceMovements.requestedBy,
  lifecycleAppliedAt: workforceMovements.lifecycleAppliedAt,
  employmentSessionId: workforceMovements.employmentSessionId,
};

/**
 * Kết thúc ĐÚNG employment session đang ACTIVE của worker vì nghỉ việc — session ACTIVE thật
 * (APPROVED + end_date IS NULL), không phải "session gần nhất theo regDate" (có thể là 1 đăng ký
 * PENDING mới — đóng nhầm sẽ làm sai lịch sử). Đồng thời dọn allocation + recompute KPI request
 * liên quan. Gọi từ applyMovementAction() (ngay khi effectiveDate <= hôm nay) HOẶC từ
 * applyEffectiveWorkforceMovements() (khi effectiveDate vừa tới) — CÙNG MỘT logic, không có
 * đường xử lý thứ 2 nào khác cho việc kết thúc session vì nghỉ việc.
 */
async function finalizeResignationEffect(
  tx: Executor,
  movement: MovementForFinalize,
  actorUsername: string,
): Promise<{ employmentSessionId: string | null }> {
  const [activeSession] = await tx
    .select({ id: employmentSessions.id })
    .from(employmentSessions)
    .where(and(
      eq(employmentSessions.workerId, movement.workerId),
      eq(employmentSessions.status, "APPROVED"),
      isNull(employmentSessions.endDate),
    ))
    .orderBy(desc(employmentSessions.regDate))
    .for("update");
  const fallbackSession = activeSession
    ? null
    : (await tx
        .select({ id: employmentSessions.id })
        .from(employmentSessions)
        .where(eq(employmentSessions.workerId, movement.workerId))
        .orderBy(desc(employmentSessions.regDate))
        .limit(1))[0] ?? null;
  const sessionToEnd = activeSession ?? fallbackSession;
  if (sessionToEnd) {
    await tx
      .update(employmentSessions)
      .set({
        status: "ENDED",
        endDate: movement.effectiveDate,
        endReason: "RESIGNATION",
        endedBy: actorUsername,
        endedAt: new Date(),
        endMovementId: movement.id,
      })
      .where(eq(employmentSessions.id, sessionToEnd.id));
  }

  // WORKFORCE REQUEST LINKAGE (mục 4 + 9): nghỉ việc có hiệu lực → kết thúc mọi ACTIVE request
  // allocation của worker (ghi history action=END). KHÔNG xoá allocation history — Quit KPI đọc
  // từ đây. KPI Request tự giảm Current Workforce vì Employment Session đã đóng.
  const { affectedRequestIds } = await endActiveRequestAllocationsForWorker(
    movement.workerId,
    actorUsername,
    `Nghỉ việc có hiệu lực (movement ${movement.id})`,
    tx,
  );
  for (const requestId of affectedRequestIds) {
    await recomputeStoredRecruitmentBalance(tx, requestId);
  }

  return { employmentSessionId: sessionToEnd?.id ?? null };
}

/**
 * Chuyển ĐÚNG employment session đang ACTIVE của worker sang bộ phận mới — cùng 1 session tiếp
 * tục (Transfer KHÔNG kết thúc employment, không phải Resignation). Gọi từ applyMovementAction()
 * (ngay khi effectiveDate <= hôm nay) HOẶC từ applyEffectiveWorkforceMovements() (khi
 * effectiveDate vừa tới) — CÙNG MỘT logic.
 */
async function finalizeTransferEffect(tx: Executor, movement: MovementForFinalize, actorUsername: string): Promise<void> {
  if (!movement.toDeptId) return;
  const [currentSession] = await tx
    .select({ id: employmentSessions.id, dailyApplicationId: employmentSessions.dailyApplicationId })
    .from(employmentSessions)
    .where(and(
      eq(employmentSessions.workerId, movement.workerId),
      eq(employmentSessions.status, "APPROVED"),
      isNull(employmentSessions.endDate),
    ))
    .orderBy(desc(employmentSessions.regDate))
    .for("update");
  if (!currentSession) return;
  await tx.update(employmentSessions).set({ deptId: movement.toDeptId }).where(eq(employmentSessions.id, currentSession.id));
  if (currentSession.dailyApplicationId) {
    await tx
      .update(dailyApplications)
      .set({ deptId: movement.toDeptId })
      .where(eq(dailyApplications.id, currentSession.dailyApplicationId));
  }
  // Tự động phân bổ lại vào Kế hoạch Tập nghề của bộ phận đích khi Transfer có hiệu lực.
  await autoAllocateInternship(currentSession.id, movement.toDeptId, movement.effectiveDate, actorUsername, tx);
}

/**
 * Áp dụng 1 hành động HR lên 1 yêu cầu — trả về bản ghi đã cập nhật + (nếu có) bản ghi
 * resignation mới sinh ra.
 *
 * P1-1 (Production Hardening Audit) — TRƯỚC ĐÂY mỗi action update nhiều bảng rời rạc (không
 * transaction): APPROVE_RESIGNATION đụng employment_sessions + workforce_movements,
 * CONFIRM_ARRIVED đụng employment_sessions + daily_applications + workforce_movements — nếu 1
 * bước giữa chừng lỗi (mất kết nối DB, timeout...) thì các bước trước đã commit rồi, để lại
 * dữ liệu nửa vời (vd worker đã đổi bộ phận nhưng movement vẫn PENDING_HR). Nay toàn bộ đọc/ghi
 * nghiệp vụ chạy trong 1 `db.transaction()` — lỗi bất kỳ bước nào rollback hết. Notification
 * (queueNotification) CHẠY SAU khi transaction đã commit — không bắt buộc atomic với nghiệp vụ
 * chính (tự nuốt + log lỗi riêng, xem lib/notifications.ts — không rollback gì nếu nó fail).
 *
 * P1-2 — SPAWN_RESIGNATION được kiểm tra idempotent NGAY TRONG transaction (đã spawn từ
 * `relatedMovementId` này chưa) trước khi insert, cộng với unique index cấp DB
 * (`workforce_movement_spawn_resignation_uq`) làm lưới an toàn cuối cho race thật (2 request
 * cùng lúc) — double-click/retry không còn sinh 2 resignation cho cùng 1 yêu cầu.
 *
 * EFFECTIVE-DATE LIFECYCLE — APPROVE_RESIGNATION/CONFIRM_ARRIVED luôn ghi quyết định HR ngay
 * (status/confirmedBy/confirmedAt), nhưng chỉ gọi finalize*Effect() NGAY nếu
 * movement.effectiveDate <= hôm nay; nếu hiệu lực trong tương lai, lifecycleAppliedAt để NULL —
 * worker/department vẫn giữ trạng thái TRƯỚC đó ("Sắp nghỉ"/"Sắp chuyển") cho tới khi
 * applyEffectiveWorkforceMovements() áp dụng vào đúng ngày.
 */
export async function applyMovementAction(
  session: Session,
  movementId: string,
  action: MovementAction,
  extra: { newEffectiveDate?: string; note?: string } = {},
) {
  const result = await db.transaction(async (tx) => {
    const [movement] = await tx.select(MOVEMENT_FINALIZE_COLUMNS).from(workforceMovements).where(eq(workforceMovements.id, movementId)).for("update");
    if (!movement) throw new Error("Không tìm thấy yêu cầu.");
    if (!isActionAllowed(movement.movementType, movement.status, action)) {
      throw new Error(`Không thể thực hiện hành động này ở trạng thái hiện tại (${movement.status}).`);
    }

    let newStatus = movement.status;
    let spawnedResignationId: string | null = null;
    const movementPatch: Record<string, unknown> = {};

    switch (action) {
      case "APPROVE_RESIGNATION": {
        newStatus = "INACTIVE";
        movementPatch.confirmedBy = session.username;
        movementPatch.confirmedAt = new Date();
        movementPatch.source = movement.source ?? "DEPT_REPORT";
        if (movement.effectiveDate <= todayStr()) {
          const { employmentSessionId } = await finalizeResignationEffect(tx, movement, session.username);
          movementPatch.employmentSessionId = employmentSessionId;
          movementPatch.lifecycleAppliedAt = new Date();
        }
        break;
      }
      case "REJECT":
        newStatus = "REJECTED";
        break;
      case "CONFIRM_ARRIVED": {
        newStatus = "TRANSFER_COMPLETED";
        if (movement.effectiveDate <= todayStr()) {
          await finalizeTransferEffect(tx, movement, session.username);
          movementPatch.lifecycleAppliedAt = new Date();
        }
        break;
      }
      case "RESCHEDULE": {
        if (!extra.newEffectiveDate) throw new Error("Cần nhập ngày chuyển mới.");
        newStatus = "TRANSFER_RESCHEDULED";
        movementPatch.effectiveDate = extra.newEffectiveDate;
        movementPatch.note = extra.note ?? movement.note;
        break;
      }
      case "NOT_ARRIVED":
        newStatus = "WAITING_DECISION";
        break;
      case "CANCEL":
        newStatus = "CANCELLED";
        break;
      case "SPAWN_RESIGNATION": {
        // Idempotency: nếu request này ĐÃ từng spawn resignation (double-click/retry), trả về
        // bản ghi cũ — không insert thêm.
        const [existing] = await tx
          .select({ id: workforceMovements.id })
          .from(workforceMovements)
          .where(and(eq(workforceMovements.relatedMovementId, movement.id), eq(workforceMovements.movementType, "resignation")));
        if (existing) {
          spawnedResignationId = existing.id;
          break;
        }
        try {
          const [spawned] = await tx
            .insert(workforceMovements)
            .values({
              movementType: "resignation",
              workerId: movement.workerId,
              fromDeptId: movement.fromDeptId,
              effectiveDate: movement.effectiveDate,
              reason: "Sinh tự động từ yêu cầu Thuyên chuyển không đến nhận việc",
              note: extra.note ?? null,
              status: "PENDING_HR",
              relatedMovementId: movement.id,
              requestedBy: session.username,
            })
            .returning({ id: workforceMovements.id });
          spawnedResignationId = spawned.id;
        } catch (e) {
          // Lưới an toàn cấp DB (unique index) cho race thật giữa 2 request đồng thời —
          // dịch lỗi 23505 (unique_violation) thành thông báo nghiệp vụ rõ ràng thay vì để lộ lỗi DB thô.
          if ((e as { code?: string }).code === "23505") {
            throw new Error("Yêu cầu Nghỉ việc liên quan đã được sinh ra trước đó (trùng lặp thao tác).");
          }
          throw e;
        }
        // Bản thân yêu cầu transfer giữ nguyên WAITING_DECISION — HR xử lý resignation mới sinh riêng.
        break;
      }
    }

    const [updated] = await tx
      .update(workforceMovements)
      .set({ ...movementPatch, status: newStatus, updatedAt: new Date() })
      .where(eq(workforceMovements.id, movementId))
      .returning();

    return { movement: updated, spawnedResignationId, requestedBy: movement.requestedBy, movementType: movement.movementType };
  });

  // Notification: HR duyệt xong -> Manager (người tạo yêu cầu) nhận được thông báo. Chạy SAU khi
  // transaction ở trên đã commit — không bắt buộc atomic với nghiệp vụ chính (xem lib/notifications.ts).
  await queueNotification({
    event: "WORKFORCE_MOVEMENT_" + action,
    recipientType: "USER",
    recipientRef: result.requestedBy,
    templateKey: "workforce_movement_updated",
    payload: { movementId, movementType: result.movementType, newStatus: result.movement.status, action },
  });

  return { movement: result.movement, spawnedResignationId: result.spawnedResignationId };
}

/**
 * Áp dụng hiệu lực cho mọi yêu cầu Nghỉ việc/Thuyên chuyển ĐÃ ĐƯỢC DUYỆT (status='INACTIVE'
 * cho resignation, 'TRANSFER_COMPLETED' cho transfer) nhưng CHƯA áp dụng vào trạng thái làm
 * việc thật (lifecycleAppliedAt IS NULL) và ngày hiệu lực đã tới (effectiveDate <= asOf).
 *
 * Đây là service duy nhất "hiện thực hoá" một quyết định HR đã duyệt trước đó thành thay đổi
 * thật trên employment_sessions/department/allocation/KPI — dùng LẠI đúng finalize*Effect() mà
 * applyMovementAction() gọi khi hiệu lực ngay lập tức, không có logic nghiệp vụ thứ 2.
 *
 * Gọi từ scheduler (lib/scheduler.ts, qua /api/cron/run) — đây là "trigger" chính đảm bảo hệ
 * thống ĐÚNG kể cả không ai mở UI vào đúng ngày hiệu lực. Idempotent: mỗi movement được khoá
 * dòng (`for("update")`) VÀ kiểm tra lại lifecycleAppliedAt NGAY TRONG transaction trước khi áp
 * dụng — 2 lần chạy chồng nhau (cron trùng lịch, retry) không áp dụng 2 lần.
 */
export async function applyEffectiveWorkforceMovements(asOf: string = todayStr()) {
  const due = await db
    .select({ id: workforceMovements.id })
    .from(workforceMovements)
    .where(and(
      isNull(workforceMovements.lifecycleAppliedAt),
      lte(workforceMovements.effectiveDate, asOf),
      or(eq(workforceMovements.status, "INACTIVE"), eq(workforceMovements.status, "TRANSFER_COMPLETED")),
    ));

  let resignationsApplied = 0;
  let transfersApplied = 0;
  const appliedIds: string[] = [];

  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [locked] = await tx.select(MOVEMENT_FINALIZE_COLUMNS).from(workforceMovements).where(eq(workforceMovements.id, id)).for("update");
      // Race guard: đã bị applyMovementAction() hoặc 1 lần chạy cron khác áp dụng giữa lúc quét
      // và lúc khoá dòng này — bỏ qua, không áp dụng lại.
      if (!locked || locked.lifecycleAppliedAt || locked.effectiveDate > asOf) return;

      if (locked.movementType === "resignation" && locked.status === "INACTIVE") {
        const { employmentSessionId } = await finalizeResignationEffect(tx, locked, "system:effective_date_scheduler");
        await tx
          .update(workforceMovements)
          .set({ employmentSessionId: employmentSessionId ?? locked.employmentSessionId, lifecycleAppliedAt: new Date(), updatedAt: new Date() })
          .where(eq(workforceMovements.id, id));
        resignationsApplied++;
        appliedIds.push(id);
      } else if (locked.movementType === "transfer" && locked.status === "TRANSFER_COMPLETED") {
        await finalizeTransferEffect(tx, locked, "system:effective_date_scheduler");
        await tx
          .update(workforceMovements)
          .set({ lifecycleAppliedAt: new Date(), updatedAt: new Date() })
          .where(eq(workforceMovements.id, id));
        transfersApplied++;
        appliedIds.push(id);
      }
    });
  }

  return { checked: due.length, resignationsApplied, transfersApplied, appliedIds };
}
