/**
 * Trigger Cloud Run PDF worker sau khi tạo job — KHÔNG giữ HTTP request mở.
 *
 * Dùng Next.js after() (giống import engine v3) để lời gọi thật sự được gửi đi
 * kể cả khi response đã trả về trình duyệt. Nếu trigger thất bại (mất mạng,
 * cold start...) thì watchdog cron (Phase 4) sẽ reclaim/resume job treo.
 */

import "server-only";
import { after } from "next/server";

export function triggerPdfWorker(jobId: string): void {
  const baseUrl = process.env.PDF_MERGE_WORKER_URL?.trim();
  if (!baseUrl) return; // chưa cấu hình worker (dev/test) — job ở QUEUED, watchdog xử lý sau.

  const secret = process.env.MERGE_WORKER_SECRET ?? "";

  after(async () => {
    try {
      await fetch(`${baseUrl.replace(/\/$/, "")}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({ jobId }),
      });
    } catch {
      /* watchdog reclaim sau (Phase 4 cron) */
    }
  });
}
