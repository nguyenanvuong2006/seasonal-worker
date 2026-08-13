import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, employmentSessions, workforceMovements } from "@/db/schema";
import { queueNotification } from "@/lib/notifications";
import { autoAllocateInternship } from "@/lib/planning";
import type { Session } from "@/lib/auth";

/**
 * WORKFORCE MOVEMENT (Phase 2, Step 3) — Nghỉ việc + Thuyên chuyển dùng CHUNG 1 bảng
 * (workforceMovements.movementType phân biệt) theo đúng quyết định đã xác nhận.
 * Trạng thái (status) là 1 stageKey đọc/ghi qua Workflow Engine dùng chung
 * (workflow_stages entityType='resignation'|'transfer') — không hard-code state machine ở đây,
 * chỉ kiểm tra "hành động nào hợp lệ ở trạng thái nào" (đây là RÀNG BUỘC NGHIỆP VỤ, khác với
 * "trạng thái trông như thế nào" — cái sau mới thuộc Workflow Engine).
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
 */
export async function applyMovementAction(
  session: Session,
  movementId: string,
  action: MovementAction,
  extra: { newEffectiveDate?: string; note?: string } = {},
) {
  const result = await db.transaction(async (tx) => {
    const [movement] = await tx.select().from(workforceMovements).where(eq(workforceMovements.id, movementId)).for("update");
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
        // Cập nhật session làm việc gần nhất của worker sang kết thúc.
        const [latestSession] = await tx
          .select()
          .from(employmentSessions)
          .where(eq(employmentSessions.workerId, movement.workerId))
          .orderBy(desc(employmentSessions.regDate));
        if (latestSession) {
          await tx.update(employmentSessions).set({ endDate: movement.effectiveDate }).where(eq(employmentSessions.id, latestSession.id));
        }
        break;
      }
      case "REJECT":
        newStatus = "REJECTED";
        break;
      case "CONFIRM_ARRIVED": {
        newStatus = "TRANSFER_COMPLETED";
        if (movement.toDeptId) {
          // Cập nhật bộ phận thật — chỉ session GẦN NHẤT (đang hoạt động) + đúng 1 bản ghi
          // daily_applications liên kết trực tiếp qua FK, không đụng lịch sử các lần đăng ký cũ.
          const [currentSession] = await tx
            .select()
            .from(employmentSessions)
            .where(eq(employmentSessions.workerId, movement.workerId))
            .orderBy(desc(employmentSessions.regDate));
          if (currentSession) {
            await tx.update(employmentSessions).set({ deptId: movement.toDeptId }).where(eq(employmentSessions.id, currentSession.id));
            if (currentSession.dailyApplicationId) {
              await tx
                .update(dailyApplications)
                .set({ deptId: movement.toDeptId })
                .where(eq(dailyApplications.id, currentSession.dailyApplicationId));
            }
            // Tự động phân bổ lại vào Kế hoạch Tập nghề của bộ phận đích khi Transfer hoàn tất
            await autoAllocateInternship(currentSession.id, movement.toDeptId, movement.effectiveDate, session.username, tx);
          }
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
