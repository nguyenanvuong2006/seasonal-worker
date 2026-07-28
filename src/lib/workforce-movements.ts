import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, employmentSessions, workforceMovements } from "@/db/schema";
import { queueNotification } from "@/lib/notifications";
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

/** Áp dụng 1 hành động HR lên 1 yêu cầu — trả về bản ghi đã cập nhật + (nếu có) bản ghi resignation mới sinh ra. */
export async function applyMovementAction(
  session: Session,
  movementId: string,
  action: MovementAction,
  extra: { newEffectiveDate?: string; note?: string } = {},
) {
  const [movement] = await db.select().from(workforceMovements).where(eq(workforceMovements.id, movementId));
  if (!movement) throw new Error("Không tìm thấy yêu cầu.");
  if (!isActionAllowed(movement.movementType, movement.status, action)) {
    throw new Error(`Không thể thực hiện hành động này ở trạng thái hiện tại (${movement.status}).`);
  }

  let newStatus = movement.status;
  let spawnedResignationId: string | null = null;

  switch (action) {
    case "APPROVE_RESIGNATION": {
      newStatus = "INACTIVE";
      // Cập nhật session làm việc gần nhất của worker sang kết thúc.
      const [latestSession] = await db
        .select()
        .from(employmentSessions)
        .where(eq(employmentSessions.workerId, movement.workerId))
        .orderBy(desc(employmentSessions.regDate));
      if (latestSession) {
        await db.update(employmentSessions).set({ endDate: movement.effectiveDate }).where(eq(employmentSessions.id, latestSession.id));
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
        const [currentSession] = await db
          .select()
          .from(employmentSessions)
          .where(eq(employmentSessions.workerId, movement.workerId))
          .orderBy(desc(employmentSessions.regDate));
        if (currentSession) {
          await db.update(employmentSessions).set({ deptId: movement.toDeptId }).where(eq(employmentSessions.id, currentSession.id));
          if (currentSession.dailyApplicationId) {
            await db
              .update(dailyApplications)
              .set({ deptId: movement.toDeptId })
              .where(eq(dailyApplications.id, currentSession.dailyApplicationId));
          }
        }
      }
      break;
    }
    case "RESCHEDULE": {
      if (!extra.newEffectiveDate) throw new Error("Cần nhập ngày chuyển mới.");
      newStatus = "TRANSFER_RESCHEDULED";
      await db
        .update(workforceMovements)
        .set({ effectiveDate: extra.newEffectiveDate, note: extra.note ?? movement.note })
        .where(eq(workforceMovements.id, movementId));
      break;
    }
    case "NOT_ARRIVED":
      newStatus = "WAITING_DECISION";
      break;
    case "CANCEL":
      newStatus = "CANCELLED";
      break;
    case "SPAWN_RESIGNATION": {
      const [spawned] = await db
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
      // Bản thân yêu cầu transfer giữ nguyên WAITING_DECISION — HR xử lý resignation mới sinh riêng.
      break;
    }
  }

  const [updated] = await db
    .update(workforceMovements)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(workforceMovements.id, movementId))
    .returning();

  // Notification: HR duyệt xong -> Manager (người tạo yêu cầu) nhận được thông báo.
  await queueNotification({
    event: "WORKFORCE_MOVEMENT_" + action,
    recipientType: "USER",
    recipientRef: movement.requestedBy,
    templateKey: "workforce_movement_updated",
    payload: { movementId, movementType: movement.movementType, newStatus, action },
  });

  return { movement: updated, spawnedResignationId };
}
