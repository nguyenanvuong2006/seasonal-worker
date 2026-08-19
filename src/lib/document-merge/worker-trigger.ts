/**
 * Trigger Cloud Run PDF worker sau khi tạo job — KHÔNG giữ HTTP request mở.
 *
 * Dùng Next.js after() (giống import engine v3) để lời gọi thật sự được gửi đi
 * kể cả khi response đã trả về trình duyệt. Nếu trigger thất bại (mất mạng,
 * cold start...) thì watchdog cron (Phase 4) sẽ reclaim/resume job treo.
 *
 * Auth (giống callWorker): nếu GOOGLE_WIF_* cấu hình → lấy Google ID token
 * (Vercel OIDC → STS → generateIdToken, aud = worker URL) gửi trong
 * Authorization; app secret gửi ở header X-Merge-Worker-Secret. Ngược lại gửi
 * Authorization: Bearer secret như cũ.
 */

import "server-only";
import { after } from "next/server";
import { getCloudRunIdToken, getGcpWifConfig, getOidcTokenFromRequest } from "@/lib/verification/gcp-oidc";

export function triggerPdfWorker(jobId: string, request?: Request): void {
  const baseUrl = process.env.PDF_MERGE_WORKER_URL?.trim();
  if (!baseUrl) return; // chưa cấu hình worker (dev/test) — job ở QUEUED, watchdog xử lý sau.

  const secret = process.env.MERGE_WORKER_SECRET ?? "";
  const serviceUrl = baseUrl.replace(/\/$/, "");
  const url = serviceUrl + "/run";
  const oidcToken = getOidcTokenFromRequest(request);

  after(async () => {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (getGcpWifConfig() && oidcToken) {
        // Audience = service URL (không path) — Cloud Run verify aud khớp service.
        const tokenResult = await getCloudRunIdToken(serviceUrl, request);
        if ("error" in tokenResult) {
          console.error(JSON.stringify({ event: "pdf_worker_trigger_auth_error", jobId, error: tokenResult.error.slice(0, 200) }));
          return;
        }
        headers.Authorization = `Bearer ${tokenResult.idToken}`;
        if (secret) headers["X-Merge-Worker-Secret"] = secret;
      } else if (secret) {
        headers.Authorization = `Bearer ${secret}`;
      }

      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jobId }),
      });
    } catch {
      /* watchdog reclaim sau (Phase 4 cron) */
    }
  });
}
