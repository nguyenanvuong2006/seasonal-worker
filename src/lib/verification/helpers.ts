/**
 * Document Merge — cloud verification feature flag + shared helpers.
 *
 * VERIFICATION_ENABLED=true CHỈ có ý nghĩa ở non-production (preview/staging).
 * Production luôn trả false → các route verification trả 403.
 * Không bao giờ expose secrets; không cho nhập arbitrary input từ client
 * (chỉ các giá trị cố định: records ∈ {1,10}, counts ∈ {1,10,50,100}).
 */

import { getCloudRunIdToken, getGcpWifConfig } from "./gcp-oidc.ts";

export function isVerificationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERIFICATION_ENABLED !== "true") return false;
  if (env.VERCEL_ENV === "production") return false;
  if (!env.VERCEL_ENV && env.NODE_ENV === "production") return false;
  return true;
}

/** Worker URL + secret (server-only — không bao giờ trả cho client). */
export function getWorkerConfig(): { url: string; secret: string } {
  return {
    url: (process.env.PDF_MERGE_WORKER_URL ?? "").replace(/\/+$/, ""),
    secret: process.env.MERGE_WORKER_SECRET ?? "",
  };
}

export type WorkerEndpoint = "/health" | "/run" | "/verify-visual" | "/benchmark";

/** Contract endpoint → HTTP method (worker: GET /health, POST còn lại). */
const WORKER_METHODS: Record<WorkerEndpoint, "GET" | "POST"> = {
  "/health": "GET",
  "/run": "POST",
  "/verify-visual": "POST",
  "/benchmark": "POST",
};

export interface CallWorkerOptions {
  /**
   * Request hiện tại — dùng để lấy Vercel OIDC token (header
   * `x-vercel-oidc-token`) khi Cloud Run yêu cầu IAM auth.
   */
  request?: Request;
}

/**
 * Gọi worker endpoint (server-side).
 *
 * Auth 2 lớp:
 * - Cloud Run IAM: khi GOOGLE_WIF_* được cấu hình, lấy Google ID token
 *   (aud = worker URL) qua Vercel OIDC → STS → generateIdToken và gửi trong
 *   `Authorization: Bearer <id_token>`. App secret được gửi ở header riêng
 *   `X-Merge-Worker-Secret` (worker chấp nhận cả 2 nguồn — không weaken auth).
 * - Không có GOOGLE_WIF_* (local/dev): giữ hành vi cũ
 *   `Authorization: Bearer <MERGE_WORKER_SECRET>`.
 */
export async function callWorker<T>(
  path: WorkerEndpoint,
  body?: unknown,
  timeoutMs = 120_000,
  options: CallWorkerOptions = {},
): Promise<{ ok: boolean; status: number; data: T | { error?: string } }> {
  const { url, secret } = getWorkerConfig();
  if (!url) return { ok: false, status: 503, data: { error: "PDF_MERGE_WORKER_URL chưa cấu hình." } };

  const method = WORKER_METHODS[path];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (getGcpWifConfig()) {
      // Cloud Run IAM auth: Authorization mang Google ID token.
      const tokenResult = await getCloudRunIdToken(url, options.request);
      if ("error" in tokenResult) {
        return { ok: false, status: 502, data: { error: tokenResult.error } };
      }
      headers.Authorization = `Bearer ${tokenResult.idToken}`;
      if (secret) headers["X-Merge-Worker-Secret"] = secret;
    } else if (secret) {
      headers.Authorization = `Bearer ${secret}`;
    }

    const res = await fetch(`${url}${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}
