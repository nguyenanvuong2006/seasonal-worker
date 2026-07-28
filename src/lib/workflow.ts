import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { workflowStages, type WorkflowStage } from "@/db/schema";

/**
 * WORKFLOW ENGINE (nền tảng, #5)
 * -------------------------------
 * Thay STATUS_META hard-code (src/lib/helpers.ts) bằng bảng workflow_stages —
 * admin thêm/sửa/xoá/đổi màu/đổi thứ tự bước tại /admin/workflow, không cần
 * sửa code. Cột `daily_applications.status` VẪN LÀ NGUỒN SỰ THẬT lưu trạng
 * thái hiện tại của 1 hồ sơ (không đổi kiểu dữ liệu, không phá dữ liệu cũ) —
 * workflow_stages chỉ mô tả "các giá trị status hợp lệ trông như thế nào".
 * Vì vậy đổi tên/màu 1 bước không cần migrate dữ liệu.
 */

let cache: { at: number; rows: WorkflowStage[] } | null = null;
const CACHE_MS = 15_000;

export async function getWorkflowStages(entityType = "daily_application"): Promise<WorkflowStage[]> {
  const now = Date.now();
  if (!cache || now - cache.at > CACHE_MS) {
    const rows = await db.select().from(workflowStages).orderBy(asc(workflowStages.sortOrder));
    cache = { at: now, rows };
  }
  return cache.rows.filter((r) => r.entityType === entityType);
}

export function invalidateWorkflowCache() {
  cache = null;
}

export const DEFAULT_WORKFLOW_STAGES: {
  stageKey: string;
  label: string;
  color: string;
  sortOrder: number;
  isStart?: boolean;
  isEnd?: boolean;
}[] = [
  { stageKey: "PENDING", label: "Chờ duyệt", color: "amber", sortOrder: 1, isStart: true },
  { stageKey: "APPROVED", label: "Đã nhận việc", color: "green", sortOrder: 2, isEnd: true },
  { stageKey: "WAITLIST", label: "Dự phòng", color: "blue", sortOrder: 3 },
  { stageKey: "REJECTED", label: "Không nhận", color: "red", sortOrder: 4, isEnd: true },
];

/**
 * WORKFORCE MOVEMENT (Phase 2, Step 3) — Workflow Engine dùng chung cho Nghỉ việc
 * (entityType="resignation") và Thuyên chuyển (entityType="transfer"), đúng mục
 * 10 yêu cầu nghiệp vụ ("Không viết workflow riêng từng module"). Trạng thái ở
 * đây khớp 1-1 với workforceMovements.status (xem src/db/schema.ts).
 */
export const DEFAULT_MOVEMENT_WORKFLOW_STAGES: Record<
  "resignation" | "transfer",
  { stageKey: string; label: string; color: string; sortOrder: number; isStart?: boolean; isEnd?: boolean }[]
> = {
  resignation: [
    { stageKey: "PENDING_HR", label: "Chờ HR duyệt", color: "amber", sortOrder: 1, isStart: true },
    { stageKey: "INACTIVE", label: "Đã nghỉ việc", color: "gray", sortOrder: 2, isEnd: true },
    { stageKey: "REJECTED", label: "HR từ chối", color: "red", sortOrder: 3, isEnd: true },
  ],
  transfer: [
    { stageKey: "PENDING_HR", label: "Chờ HR xác nhận", color: "amber", sortOrder: 1, isStart: true },
    { stageKey: "TRANSFER_COMPLETED", label: "Đã chuyển bộ phận", color: "green", sortOrder: 2, isEnd: true },
    { stageKey: "TRANSFER_RESCHEDULED", label: "Đã hoãn (chờ ngày mới)", color: "blue", sortOrder: 3 },
    { stageKey: "WAITING_DECISION", label: "Không đến — chờ HR quyết định", color: "amber", sortOrder: 4 },
    { stageKey: "CANCELLED", label: "Đã huỷ thuyên chuyển", color: "gray", sortOrder: 5, isEnd: true },
    { stageKey: "REJECTED", label: "HR từ chối", color: "red", sortOrder: 6, isEnd: true },
  ],
};

export { workflowStages };
