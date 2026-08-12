import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";

/**
 * NOTIFICATION FOUNDATION (nền tảng, #10)
 * -----------------------------------------
 * Event → Recipient → Template → Channel → Queue. Bảng `notifications` CHÍNH
 * LÀ hàng đợi (database-backed, không cần Redis/queue ngoài — đúng yêu cầu
 * không thêm hạ tầng). Kênh "IN_APP" hoạt động thật (hiển thị trong app qua
 * /admin/notifications). Kênh ZALO/SMS/EMAIL CHƯA gửi thật — chỉ dừng ở bước
 * xếp hàng đợi (status QUEUED) vì chưa có tài khoản dịch vụ ngoài; khi có,
 * chỉ cần viết thêm 1 "sender" cho kênh đó trong processQueue() dưới đây,
 * không cần đổi kiến trúc.
 */

export async function queueNotification(input: {
  event: string;
  recipientType?: "USER" | "WORKER" | "ROLE";
  recipientRef: string;
  channel?: "IN_APP" | "ZALO" | "SMS" | "EMAIL";
  templateKey: string;
  payload?: Record<string, unknown>;
}) {
  try {
    await db.insert(notifications).values({
      event: input.event,
      recipientType: input.recipientType ?? "USER",
      recipientRef: input.recipientRef,
      channel: input.channel ?? "IN_APP",
      templateKey: input.templateKey,
      payload: input.payload ?? {},
      status: "QUEUED",
    });
  } catch (error) {
    // P1-1 (Production Hardening Audit) — notification là side-effect KHÔNG bắt buộc atomic với
    // transaction nghiệp vụ chính (đã commit xong mới gọi tới đây) — lỗi ở đây không được rollback
    // gì cả, nhưng vẫn phải log lại để không mất dấu vết (trước đây nuốt lỗi hoàn toàn im lặng).
    console.error("[notifications] queueNotification failed", { event: input.event, error });
  }
}

/** Xử lý hàng đợi — gọi từ /api/cron/run (Scheduler Foundation) hoặc thủ công. */
export async function processNotificationQueue(limit = 50) {
  const pending = await db.select().from(notifications).where(eq(notifications.status, "QUEUED")).limit(limit);
  let sent = 0;
  let skipped = 0;
  for (const n of pending) {
    if (n.channel === "IN_APP") {
      // IN_APP coi là "đã gửi" ngay khi hiển thị được trong /admin/notifications.
      await db.update(notifications).set({ status: "SENT", sentAt: new Date() }).where(eq(notifications.id, n.id));
      sent++;
    } else {
      // Chưa có nhà cung cấp Zalo/SMS/Email → giữ nguyên QUEUED, không báo lỗi giả.
      skipped++;
    }
  }
  return { sent, skipped, total: pending.length };
}
