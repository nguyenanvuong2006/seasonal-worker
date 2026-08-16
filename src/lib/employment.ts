import "server-only";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { endActiveRequestAllocationsForWorker } from "@/lib/workforce-request";
import { recomputeStoredRecruitmentBalance } from "@/lib/recruitment-kpi";
import {
  dailyApplications,
  departments,
  employmentSessions,
  startDateCorrections,
  workerProfiles,
  workforceMovements,
} from "@/db/schema";
import { todayStr } from "@/lib/helpers";
import {
  decideCorrection,
  isSessionActive,
  validateStartingDateInput,
  type EndReason,
  type MovementSource,
} from "@/lib/employment-lifecycle";

/**
 * EMPLOYMENT SERVICE — mọi thao tác ghi lên vòng đời làm việc PHẢI đi qua đây.
 *
 * SOURCE OF TRUTH:
 *   daily_applications  = lịch sử đăng ký (immutable history).
 *   employment_sessions = lịch sử làm việc (ACTIVE := APPROVED + end_date IS NULL).
 *   workforce_movements = sự kiện nghỉ việc/thuyên chuyển đã xác nhận.
 *
 * TRANSACTION SAFETY (#21): các nghiệp vụ nhiều bước (đóng session + movement + mở session mới,
 * duyệt điều chỉnh ngày...) chạy trong MỘT db.transaction() với SELECT ... FOR UPDATE trên các
 * session của worker — double-click/retry/2 request đồng thời không thể tạo 2 ACTIVE session.
 * Lưới cuối là partial unique index `employment_session_one_active_uq` (23505 được dịch thành
 * lỗi nghiệp vụ rõ ràng).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export class EmploymentRuleError extends Error {
  constructor(message: string, readonly code: string = "EMPLOYMENT_RULE") {
    super(message);
  }
}

const UNIQUE_ACTIVE_MESSAGE =
  "Người lao động đã có một đợt làm việc ACTIVE khác (thao tác trùng lặp hoặc 2 người cùng xử lý). Tải lại trang để xem trạng thái mới nhất.";

function translateUniqueActive(e: unknown): never {
  const err = e as { code?: string; constraint?: string };
  if (err.code === "23505" && err.constraint === "employment_session_one_active_uq") {
    throw new EmploymentRuleError(UNIQUE_ACTIVE_MESSAGE, "DUPLICATE_ACTIVE_EMPLOYMENT");
  }
  throw e;
}

export type ActiveSessionInfo = {
  id: string;
  workerId: string;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  startingDate: string | null;
  regDate: string;
  dailyApplicationId: string | null;
};

/** Tìm Employment Session ACTIVE hiện tại của 1 worker (theo workerId). */
export async function findActiveSession(workerId: string, executor: Executor = db): Promise<ActiveSessionInfo | null> {
  const [row] = await executor
    .select({
      id: employmentSessions.id,
      workerId: employmentSessions.workerId,
      deptId: employmentSessions.deptId,
      deptName: departments.deptName,
      groupName: departments.groupName,
      startingDate: employmentSessions.startingDate,
      regDate: employmentSessions.regDate,
      dailyApplicationId: employmentSessions.dailyApplicationId,
    })
    .from(employmentSessions)
    .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
    .where(and(eq(employmentSessions.workerId, workerId), eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate)))
    .orderBy(desc(employmentSessions.regDate), desc(employmentSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/** Tìm Employment Session ACTIVE theo CCCD (canonical identity của worker_profiles). */
export async function findActiveSessionByCccd(cccd: string, executor: Executor = db): Promise<(ActiveSessionInfo & { workerCccd: string }) | null> {
  const [profile] = await executor
    .select({ id: workerProfiles.id })
    .from(workerProfiles)
    .where(and(eq(workerProfiles.cccd, cccd), isNull(workerProfiles.deletedAt)))
    .limit(1);
  if (!profile) return null;
  const active = await findActiveSession(profile.id, executor);
  return active ? { ...active, workerCccd: cccd } : null;
}

/**
 * Khoá (FOR UPDATE) toàn bộ session của worker trong transaction — serialize 2 request đồng
 * thời trên cùng 1 worker trước khi kiểm tra invariant "1 ACTIVE".
 */
async function lockWorkerSessions(tx: Tx, workerId: string) {
  return tx
    .select({
      id: employmentSessions.id,
      status: employmentSessions.status,
      endDate: employmentSessions.endDate,
      deptId: employmentSessions.deptId,
      startingDate: employmentSessions.startingDate,
      dailyApplicationId: employmentSessions.dailyApplicationId,
      regDate: employmentSessions.regDate,
    })
    .from(employmentSessions)
    .where(eq(employmentSessions.workerId, workerId))
    .orderBy(desc(employmentSessions.regDate), desc(employmentSessions.createdAt))
    .for("update");
}

/**
 * #4 — BỘ PHẬN BÁO NGHỈ, người có quyền xác nhận. Đóng ĐÚNG session ACTIVE + tạo RESIGNATION
 * movement đã xác nhận trong 1 transaction. KHÔNG đụng daily_applications cũ (giữ audit).
 */
export async function confirmResignation(input: {
  workerId: string;
  effectiveDate: string;
  reason?: string | null;
  note?: string | null;
  reportedBy: string;
  confirmedBy: string;
  source: MovementSource;
  endReason?: EndReason;
  /** Movement có sẵn (từ luồng Bộ phận báo nghỉ) — nếu truyền, update movement đó thay vì tạo mới. */
  movementId?: string | null;
  executor?: Tx;
}): Promise<{ sessionId: string; movementId: string }> {
  const run = async (tx: Tx) => {
    const sessions = await lockWorkerSessions(tx, input.workerId);
    const active = sessions.find((s) => isSessionActive(s));
    if (!active) {
      throw new EmploymentRuleError("Người lao động không có Employment Session ACTIVE để xác nhận nghỉ.", "NO_ACTIVE_SESSION");
    }

    const now = new Date();
    await tx
      .update(employmentSessions)
      .set({
        status: "ENDED",
        endDate: input.effectiveDate,
        endReason: input.endReason ?? "RESIGNATION",
        endedBy: input.confirmedBy,
        endedAt: now,
      })
      .where(eq(employmentSessions.id, active.id));

    let movementId = input.movementId ?? null;
    if (movementId) {
      const [updated] = await tx
        .update(workforceMovements)
        .set({
          status: "INACTIVE",
          employmentSessionId: active.id,
          effectiveDate: input.effectiveDate,
          confirmedBy: input.confirmedBy,
          confirmedAt: now,
          source: input.source,
          updatedAt: now,
        })
        .where(eq(workforceMovements.id, movementId))
        .returning({ id: workforceMovements.id });
      if (!updated) throw new EmploymentRuleError("Không tìm thấy yêu cầu nghỉ việc liên quan.", "MOVEMENT_NOT_FOUND");
    } else {
      // Idempotent: nếu đã có resignation ĐÃ XÁC NHẬN cho đúng session này thì không tạo bản ghi trùng.
      const [existing] = await tx
        .select({ id: workforceMovements.id })
        .from(workforceMovements)
        .where(
          and(
            eq(workforceMovements.movementType, "resignation"),
            eq(workforceMovements.employmentSessionId, active.id),
            eq(workforceMovements.status, "INACTIVE"),
          ),
        )
        .limit(1);
      if (existing) {
        movementId = existing.id;
      } else {
        const [created] = await tx
          .insert(workforceMovements)
          .values({
            movementType: "resignation",
            workerId: input.workerId,
            fromDeptId: active.deptId,
            employmentSessionId: active.id,
            effectiveDate: input.effectiveDate,
            reason: input.reason ?? null,
            note: input.note ?? null,
            status: "INACTIVE", // đã xác nhận ngay trong nghiệp vụ này
            requestedBy: input.reportedBy,
            confirmedBy: input.confirmedBy,
            confirmedAt: now,
            source: input.source,
          })
          .returning({ id: workforceMovements.id });
        movementId = created.id;
      }
    }

    // employment_end trên session ↔ movement liên kết 2 chiều để truy vết.
    await tx.update(employmentSessions).set({ endMovementId: movementId }).where(eq(employmentSessions.id, active.id));

    // WORKFORCE REQUEST LINKAGE — nghỉ việc đã xác nhận → kết thúc mọi ACTIVE
    // request allocation của worker (history action=END). KPI của Workforce
    // Request tự cập nhật vì tính lại từ source (Current giảm, Quit tăng).
    const { affectedRequestIds } = await endActiveRequestAllocationsForWorker(
      input.workerId,
      input.confirmedBy,
      `Nghỉ việc được xác nhận (movement ${movementId!})`,
      tx,
    );
    // Trigger recompute KPI cho request bị ảnh hưởng (mục I.5) — Balance lưu
    // trong DB phản ánh ngay Quit During Request vừa tăng, không đợi lần đọc kế tiếp.
    for (const requestId of affectedRequestIds) {
      await recomputeStoredRecruitmentBalance(tx, requestId);
    }

    return { sessionId: active.id, movementId: movementId! };
  };

  if (input.executor) return run(input.executor);
  return db.transaction(run).catch(translateUniqueActive);
}

/**
 * #8-C — XÁC NHẬN NGHỈ + XẾP VIỆC MỚI trong MỘT transaction:
 *   1. Close Employment Session A (ENDED + end_reason=RESIGNATION)
 *   2. Create RESIGNATION movement (confirmed)
 *   3. Preserve history (không sửa application cũ)
 *   4. Approve Employment Session B (status=APPROVED, starting_date=hôm nay VN)
 * Không bao giờ tồn tại 2 ACTIVE session (lock + unique index).
 */
export async function confirmResignationAndAssign(input: {
  workerId: string;
  /** Session (PENDING/WAITLIST) của lần đăng ký mới sẽ được xếp việc. */
  newSessionId: string;
  newDeptId: string;
  actualResignationDate: string;
  startingDate?: string | null; // default = hôm nay VN — không nhận quá khứ
  reason?: string | null;
  confirmedBy: string;
}): Promise<{ endedSessionId: string; movementId: string; newSessionId: string }> {
  const today = todayStr();
  const startingDate = input.startingDate || today;
  const dateError = validateStartingDateInput(startingDate, today);
  if (dateError) throw new EmploymentRuleError(dateError, "BACKDATE_FORBIDDEN");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.actualResignationDate)) {
    throw new EmploymentRuleError("Ngày nghỉ thực tế không hợp lệ.", "INVALID_RESIGNATION_DATE");
  }

  return db
    .transaction(async (tx) => {
      const sessions = await lockWorkerSessions(tx, input.workerId);
      const target = sessions.find((s) => s.id === input.newSessionId);
      if (!target) throw new EmploymentRuleError("Không tìm thấy Employment Session của lần đăng ký mới.", "SESSION_NOT_FOUND");
      if (isSessionActive(target)) {
        // Double-click/retry: session mới đã ACTIVE rồi — idempotent, không lặp lại nghiệp vụ.
        const priorActive = sessions.find((s) => s.id !== target.id && isSessionActive(s));
        if (!priorActive) {
          const [movement] = await tx
            .select({ id: workforceMovements.id })
            .from(workforceMovements)
            .where(and(eq(workforceMovements.movementType, "resignation"), eq(workforceMovements.workerId, input.workerId)))
            .orderBy(desc(workforceMovements.createdAt))
            .limit(1);
          return { endedSessionId: "", movementId: movement?.id ?? "", newSessionId: target.id };
        }
      }

      // 1+2 — đóng session A + movement (dùng chung transaction).
      const { sessionId: endedSessionId, movementId } = await confirmResignation({
        workerId: input.workerId,
        effectiveDate: input.actualResignationDate,
        reason: input.reason ?? "Xác nhận nghỉ khi xếp việc mới",
        reportedBy: input.confirmedBy,
        confirmedBy: input.confirmedBy,
        source: "RECRUITER_CONFIRM",
        executor: tx,
      });

      // 4 — mở session B (APPROVED). Sau khi A vừa ENDED, invariant "1 ACTIVE" giữ vững.
      await tx
        .update(employmentSessions)
        .set({
          status: "APPROVED",
          deptId: input.newDeptId,
          startingDate,
          startDateSource: "ASSIGNMENT",
        })
        .where(eq(employmentSessions.id, input.newSessionId));

      // Đồng bộ daily_application của LẦN ĐĂNG KÝ MỚI (không đụng các application cũ).
      if (target.dailyApplicationId) {
        await tx
          .update(dailyApplications)
          .set({ status: "APPROVED", deptId: input.newDeptId, startingDate, updatedAt: new Date() })
          .where(eq(dailyApplications.id, target.dailyApplicationId));
      }

      return { endedSessionId, movementId, newSessionId: input.newSessionId };
    })
    .catch(translateUniqueActive);
}

/**
 * Guard dùng bởi các route xếp việc (PATCH /api/registrations/[id], POST /api/bulk-import):
 * chặn chuyển sang APPROVED khi worker còn session ACTIVE KHÁC.
 */
export async function assertNoOtherActiveSession(
  executor: Executor,
  workerId: string,
  exceptSessionId: string | null,
): Promise<void> {
  const filters = [
    eq(employmentSessions.workerId, workerId),
    eq(employmentSessions.status, "APPROVED"),
    isNull(employmentSessions.endDate),
  ];
  if (exceptSessionId) filters.push(ne(employmentSessions.id, exceptSessionId));
  const [conflict] = await executor
    .select({ id: employmentSessions.id, deptId: employmentSessions.deptId, deptName: departments.deptName })
    .from(employmentSessions)
    .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
    .where(and(...filters))
    .limit(1);
  if (conflict) {
    throw new EmploymentRuleError(
      `Người lao động đang được ghi nhận ĐANG LÀM VIỆC tại "${conflict.deptName ?? "bộ phận khác"}". Cần xác nhận nghỉ tại bộ phận cũ trước khi xếp việc mới (dùng “Yêu cầu xác nhận nghỉ” hoặc “Xác nhận nghỉ & xếp việc mới” nếu có quyền).`,
      "ACTIVE_EMPLOYMENT_EXISTS",
    );
  }
}

/**
 * #11 — Recruiter yêu cầu điều chỉnh ngày nhận việc (không update ngay).
 * Idempotent: 1 session chỉ có 1 yêu cầu PENDING (unique index) — trả về yêu cầu cũ nếu đã tồn tại.
 */
export async function requestStartDateCorrection(input: {
  employmentSessionId: string;
  requestedStartDate: string;
  reason: string;
  note?: string | null;
  requestedBy: string;
}): Promise<{ id: string; alreadyPending: boolean }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.requestedStartDate)) {
    throw new EmploymentRuleError("Ngày nhận việc thực tế không hợp lệ.", "INVALID_DATE");
  }
  if (!input.reason.trim()) {
    throw new EmploymentRuleError("Cần nhập lý do điều chỉnh ngày nhận việc.", "REASON_REQUIRED");
  }
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: employmentSessions.id, workerId: employmentSessions.workerId, startingDate: employmentSessions.startingDate })
      .from(employmentSessions)
      .where(eq(employmentSessions.id, input.employmentSessionId))
      .for("update");
    if (!session) throw new EmploymentRuleError("Không tìm thấy Employment Session.", "SESSION_NOT_FOUND");

    const [pending] = await tx
      .select({ id: startDateCorrections.id })
      .from(startDateCorrections)
      .where(and(eq(startDateCorrections.employmentSessionId, session.id), eq(startDateCorrections.status, "PENDING_ADMIN_APPROVAL")))
      .limit(1);
    if (pending) return { id: pending.id, alreadyPending: true };

    try {
      const [created] = await tx
        .insert(startDateCorrections)
        .values({
          employmentSessionId: session.id,
          workerId: session.workerId,
          currentStartDate: session.startingDate,
          requestedStartDate: input.requestedStartDate,
          reason: input.reason.trim(),
          note: (input.note ?? "").trim() || null,
          requestedBy: input.requestedBy,
        })
        .returning({ id: startDateCorrections.id });
      return { id: created.id, alreadyPending: false };
    } catch (e) {
      // Race giữa 2 request đồng thời → unique index chốt; trả về yêu cầu đã có.
      if ((e as { code?: string }).code === "23505") {
        const [existing] = await tx
          .select({ id: startDateCorrections.id })
          .from(startDateCorrections)
          .where(and(eq(startDateCorrections.employmentSessionId, session.id), eq(startDateCorrections.status, "PENDING_ADMIN_APPROVAL")))
          .limit(1);
        if (existing) return { id: existing.id, alreadyPending: true };
      }
      throw e;
    }
  });
}

/**
 * #12 — Admin duyệt/reject điều chỉnh ngày nhận việc trong transaction an toàn.
 * APPROVE: update starting_date + lưu old/new + approved_by/at (audit không mất giá trị cũ).
 * REJECT: giữ nguyên starting_date gốc.
 */
export async function decideStartDateCorrection(input: {
  correctionId: string;
  decision: "APPROVE" | "REJECT";
  decidedBy: string;
  decisionNote?: string | null;
}): Promise<{ id: string; status: string; oldStartDate: string | null; newStartDate: string | null }> {
  return db.transaction(async (tx) => {
    const [correction] = await tx
      .select()
      .from(startDateCorrections)
      .where(eq(startDateCorrections.id, input.correctionId))
      .for("update");
    if (!correction) throw new EmploymentRuleError("Không tìm thấy yêu cầu điều chỉnh.", "CORRECTION_NOT_FOUND");

    const decision = decideCorrection({
      status: correction.status,
      decision: input.decision,
      requestedBy: correction.requestedBy,
      decidedBy: input.decidedBy,
    });
    if (!decision.ok) throw new EmploymentRuleError(decision.message, "INVALID_DECISION");

    const now = new Date();
    let oldStartDate: string | null = null;
    let newStartDate: string | null = null;

    if (decision.nextStatus === "APPROVED") {
      const [session] = await tx
        .select({ id: employmentSessions.id, startingDate: employmentSessions.startingDate, dailyApplicationId: employmentSessions.dailyApplicationId })
        .from(employmentSessions)
        .where(eq(employmentSessions.id, correction.employmentSessionId))
        .for("update");
      if (!session) throw new EmploymentRuleError("Employment Session của yêu cầu không còn tồn tại.", "SESSION_NOT_FOUND");
      oldStartDate = session.startingDate;
      newStartDate = correction.requestedStartDate;
      await tx
        .update(employmentSessions)
        .set({ startingDate: correction.requestedStartDate, startDateSource: "CORRECTION" })
        .where(eq(employmentSessions.id, session.id));
      // daily_applications.starting_date là dữ liệu hiển thị/nghiệp vụ hiện hành → đồng bộ theo;
      // giá trị cũ vẫn còn trong start_date_corrections + audit log.
      if (session.dailyApplicationId) {
        await tx
          .update(dailyApplications)
          .set({ startingDate: correction.requestedStartDate, updatedAt: now })
          .where(eq(dailyApplications.id, session.dailyApplicationId));
      }
    }

    const [updated] = await tx
      .update(startDateCorrections)
      .set({
        status: decision.nextStatus,
        decidedBy: input.decidedBy,
        decidedAt: now,
        decisionNote: (input.decisionNote ?? "").trim() || null,
        oldStartDate,
        newStartDate,
      })
      .where(eq(startDateCorrections.id, correction.id))
      .returning({ id: startDateCorrections.id, status: startDateCorrections.status, oldStartDate: startDateCorrections.oldStartDate, newStartDate: startDateCorrections.newStartDate });
    return updated;
  });
}

/**
 * #7 + #14 — Bối cảnh employment cho hồ sơ 1 ứng viên (Recruiter warning + warning history).
 * Trả về: session ACTIVE hiện tại (nếu có), toàn bộ lịch sử đã kết thúc, self-declaration
 * của application, và yêu cầu xác nhận nghỉ đang chờ.
 */
export async function getEmploymentContextByCccd(cccd: string) {
  const [profile] = await db
    .select({ id: workerProfiles.id, fullName: workerProfiles.fullName })
    .from(workerProfiles)
    .where(and(eq(workerProfiles.cccd, cccd), isNull(workerProfiles.deletedAt)))
    .limit(1);
  if (!profile) {
    return { workerId: null, activeSession: null, endedSessions: [], pendingResignations: [], duplicateActive: false };
  }

  const sessions = await db
    .select({
      id: employmentSessions.id,
      deptId: employmentSessions.deptId,
      deptName: departments.deptName,
      groupName: departments.groupName,
      section: departments.section,
      status: employmentSessions.status,
      regDate: employmentSessions.regDate,
      startingDate: employmentSessions.startingDate,
      endDate: employmentSessions.endDate,
      endReason: employmentSessions.endReason,
      dailyApplicationId: employmentSessions.dailyApplicationId,
    })
    .from(employmentSessions)
    .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
    .where(eq(employmentSessions.workerId, profile.id))
    .orderBy(desc(employmentSessions.regDate), desc(employmentSessions.createdAt));

  const activeSessions = sessions.filter((s) => isSessionActive(s));
  const endedSessions = sessions.filter((s) => s.endDate || s.status === "ENDED");

  const pendingResignations = await db
    .select({ id: workforceMovements.id, effectiveDate: workforceMovements.effectiveDate, status: workforceMovements.status })
    .from(workforceMovements)
    .where(
      and(
        eq(workforceMovements.workerId, profile.id),
        eq(workforceMovements.movementType, "resignation"),
        inArray(workforceMovements.status, ["PENDING_HR"]),
      ),
    );

  return {
    workerId: profile.id,
    activeSession: activeSessions[0] ?? null,
    endedSessions,
    pendingResignations,
    duplicateActive: activeSessions.length > 1,
  };
}

/** Danh sách yêu cầu điều chỉnh ngày đang chờ Admin (Task Center). */
export async function listPendingStartDateCorrections(limit = 50) {
  return db
    .select({
      id: startDateCorrections.id,
      employmentSessionId: startDateCorrections.employmentSessionId,
      workerId: startDateCorrections.workerId,
      workerName: workerProfiles.fullName,
      workerCccd: workerProfiles.cccd,
      deptName: departments.deptName,
      applicationDate: employmentSessions.regDate,
      currentStartDate: startDateCorrections.currentStartDate,
      requestedStartDate: startDateCorrections.requestedStartDate,
      reason: startDateCorrections.reason,
      requestedBy: startDateCorrections.requestedBy,
      requestedAt: startDateCorrections.requestedAt,
    })
    .from(startDateCorrections)
    .leftJoin(workerProfiles, eq(startDateCorrections.workerId, workerProfiles.id))
    .leftJoin(employmentSessions, eq(startDateCorrections.employmentSessionId, employmentSessions.id))
    .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
    .where(eq(startDateCorrections.status, "PENDING_ADMIN_APPROVAL"))
    .orderBy(desc(startDateCorrections.requestedAt))
    .limit(limit);
}

/**
 * #17 — DATA INTEGRITY AUDIT (report-only, KHÔNG sửa dữ liệu).
 * Trả về từng nhóm bất thường để Admin đối soát bằng Reconciliation UI.
 */
export async function auditEmploymentIntegrity() {
  const duplicateActive = await db.execute(sql`
    SELECT es.worker_id AS "workerId", wp.cccd, wp.full_name AS "fullName",
           count(*)::int AS "activeCount",
           array_agg(es.id ORDER BY es.reg_date DESC) AS "sessionIds"
    FROM employment_sessions es
    JOIN worker_profiles wp ON wp.id = es.worker_id
    WHERE es.status = 'APPROVED' AND es.end_date IS NULL
    GROUP BY es.worker_id, wp.cccd, wp.full_name
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT 200`);

  const approvedAppsWithoutSession = await db.execute(sql`
    SELECT da.id, da.cccd, da.full_name AS "fullName", da.reg_date AS "regDate", da.dept_id AS "deptId"
    FROM daily_applications da
    LEFT JOIN employment_sessions es ON es.daily_application_id = da.id
    WHERE da.status = 'APPROVED' AND da.deleted_at IS NULL AND es.id IS NULL
    ORDER BY da.reg_date DESC
    LIMIT 200`);

  const activeWithoutDept = await db.execute(sql`
    SELECT es.id, es.worker_id AS "workerId", wp.cccd, wp.full_name AS "fullName", es.reg_date AS "regDate"
    FROM employment_sessions es
    JOIN worker_profiles wp ON wp.id = es.worker_id
    WHERE es.status = 'APPROVED' AND es.end_date IS NULL AND es.dept_id IS NULL
    ORDER BY es.reg_date DESC
    LIMIT 200`);

  const resignationButActive = await db.execute(sql`
    SELECT wm.id AS "movementId", wm.worker_id AS "workerId", wp.cccd, wp.full_name AS "fullName",
           wm.effective_date AS "effectiveDate", es.id AS "sessionId"
    FROM workforce_movements wm
    JOIN worker_profiles wp ON wp.id = wm.worker_id
    JOIN employment_sessions es ON es.worker_id = wm.worker_id
      AND es.status = 'APPROVED' AND es.end_date IS NULL
    WHERE wm.movement_type = 'resignation' AND wm.status = 'INACTIVE'
      AND wm.effective_date <= CURRENT_DATE
    ORDER BY wm.effective_date DESC
    LIMIT 200`);

  const endedWithoutEndDate = await db.execute(sql`
    SELECT es.id, es.worker_id AS "workerId", wp.cccd, wp.full_name AS "fullName", es.status, es.reg_date AS "regDate"
    FROM employment_sessions es
    JOIN worker_profiles wp ON wp.id = es.worker_id
    WHERE es.status IN ('ENDED','INACTIVE') AND es.end_date IS NULL
    ORDER BY es.reg_date DESC
    LIMIT 200`);

  return {
    generatedAt: new Date().toISOString(),
    duplicateActive: duplicateActive.rows,
    approvedAppsWithoutSession: approvedAppsWithoutSession.rows,
    activeWithoutDept: activeWithoutDept.rows,
    resignationButActive: resignationButActive.rows,
    endedWithoutEndDate: endedWithoutEndDate.rows,
  };
}
