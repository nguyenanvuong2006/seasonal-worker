import "server-only";
import { queueNotification } from "@/lib/notifications";
import type { NotificationProvider } from "@/lib/providers/types";

/** Implementation THẬT — dùng lại hàng đợi DB-backed đã có (src/lib/notifications.ts). */
export const inAppNotificationProvider: NotificationProvider = {
  name: "IN_APP",
  async send(input) {
    await queueNotification({
      event: input.templateKey,
      recipientRef: input.recipientRef,
      channel: "IN_APP",
      templateKey: input.templateKey,
      payload: input.payload,
    });
    return { ok: true };
  },
};

/**
 * Registry — nơi DUY NHẤT nghiệp vụ tra cứu provider đang dùng. Thêm nhà cung cấp
 * mới (vd Zalo) thì viết 1 file provider mới rồi thêm vào đây, không sửa nơi khác.
 */
export const providers = {
  notification: inAppNotificationProvider,
} as const;
