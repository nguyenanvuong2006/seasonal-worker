/**
 * Document Merge — cloud verification feature flag + shared helpers.
 *
 * VERIFICATION_ENABLED=true CHỈ có ý nghĩa ở non-production (preview/staging).
 * Production luôn trả false → các route verification trả 403.
 * Không bao giờ expose secrets; không cho nhập arbitrary input từ client
 * (chỉ các giá trị cố định: records ∈ {1,10}, counts ∈ {1,10,50,100}).
 */

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

const WORKER_METHODS: Record<WorkerEndpoint, "GET" | "POST"> = {
  "/health": "GET",
  "/run": "POST",
  "/verify-visual": "POST",
  "/benchmark": "POST",
};

/** Gọi worker endpoint (server-side). */
export async function callWorker<T>(
  path: WorkerEndpoint,
  body?: unknown,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; status: number; data: T | { error?: string } }> {
  const { url, secret } = getWorkerConfig();
  if (!url) return { ok: false, status: 503, data: { error: "PDF_MERGE_WORKER_URL chưa cấu hình." } };

  const method = WORKER_METHODS[path];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: method === "GET" ? undefined : body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}
