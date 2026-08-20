/**
 * Trigger Cloud Run PDF worker sau khi tạo job — KHÔNG giữ HTTP request mở.
 *
 * Dùng Next.js after() để lời gọi thật sự được gửi đi kể cả khi response đã
 * trả về trình duyệt.
 *
 * Auth: dùng CHUNG `callWorker()` (src/lib/verification/helpers.ts) — helper
 * xác thực DUY NHẤT cho mọi lời gọi worker (Check Worker, verification E2E,
 * merge thật). Trước đây file này tự lặp lại toàn bộ logic OIDC→STS→
 * generateIdToken + header construction VÀ không kiểm tra response — một
 * request bị worker từ chối (401 do X-Merge-Worker-Secret sai/thiếu) sẽ bị
 * nuốt lặng lẽ, job kẹt QUEUED không ai biết vì sao. Giờ log lỗi (an toàn,
 * không secret) qua stage/status để chẩn đoán được ngay, và chỉ có 1 chỗ auth
 * cần đúng thay vì 2 bản dễ lệch nhau.
 */

import "server-only";
import { after } from "next/server";
import { callWorker } from "@/lib/verification/helpers";

export function triggerPdfWorker(jobId: string, request?: Request): void {
  after(async () => {
    const result = await callWorker<{ processed?: number; failed?: number }>("/run", { jobId }, 30_000, { request });
    if (!result.ok) {
      // Không log secret/token — chỉ stage/status/diagnostics an toàn.
      console.error(
        JSON.stringify({
          event: "pdf_worker_trigger_failed",
          jobId,
          stage: result.stage ?? null,
          status: result.status,
          error: (result.data as { error?: string } | undefined)?.error?.slice(0, 200) ?? null,
          diagnostics: result.diagnostics ?? null,
        }),
      );
    }
  });
}
