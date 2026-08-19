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

/** Cloud Run staging service hostname hiện tại (asia-southeast1, seasonal-worker-505710). */
export const EXPECTED_STAGING_WORKER_HOSTNAME =
  "seasonal-worker-pdf-staging-68054464426.asia-southeast1.run.app";

export interface WorkerUrlDiagnostics {
  configured: boolean;
  /** host (không có scheme/path) — an toàn để log/hiển thị. */
  workerHost: string | null;
  /** path còn lại sau host, nếu có (KHÔNG nên có — PDF_MERGE_WORKER_URL chỉ chứa base URL). */
  workerPath: string | null;
  hostnameMatchesExpectedStaging: boolean | null;
  /** Set khi PDF_MERGE_WORKER_URL thiếu / không phải URL hợp lệ / có path thừa. */
  error: string | null;
}

/**
 * Chẩn đoán an toàn cho PDF_MERGE_WORKER_URL — KHÔNG bao giờ trả secret/token.
 * Phát hiện lỗi cấu hình phổ biến: quên set, URL sai định dạng, hoặc lỡ nối
 * `/health` (hay path khác) vào biến môi trường thay vì chỉ để base URL.
 */
export function diagnoseWorkerUrl(
  rawUrl: string = process.env.PDF_MERGE_WORKER_URL ?? "",
): WorkerUrlDiagnostics {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      configured: false,
      workerHost: null,
      workerPath: null,
      hostnameMatchesExpectedStaging: null,
      error: "PDF_MERGE_WORKER_URL chưa cấu hình.",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      configured: true,
      workerHost: null,
      workerPath: null,
      hostnameMatchesExpectedStaging: null,
      error: "PDF_MERGE_WORKER_URL không phải URL hợp lệ.",
    };
  }
  const workerHost = parsed.host;
  const workerPath = parsed.pathname === "/" ? "" : parsed.pathname;
  const hostnameMatchesExpectedStaging = workerHost === EXPECTED_STAGING_WORKER_HOSTNAME;
  if (workerPath) {
    return {
      configured: true,
      workerHost,
      workerPath,
      hostnameMatchesExpectedStaging,
      error: `PDF_MERGE_WORKER_URL phải chỉ chứa base URL (không có path). Đang có path "${workerPath}" — bỏ path này khỏi biến môi trường trên Vercel.`,
    };
  }
  return {
    configured: true,
    workerHost,
    workerPath: "",
    hostnameMatchesExpectedStaging,
    error: hostnameMatchesExpectedStaging
      ? null
      : "PDF_MERGE_WORKER_URL does not point to the expected staging Cloud Run service",
  };
}

const REQUIRED_VERIFICATION_ENV_KEYS = [
  "PDF_MERGE_WORKER_URL",
  "MERGE_WORKER_SECRET",
  "GOOGLE_WIF_PROJECT_NUMBER",
  "GOOGLE_WIF_POOL_ID",
  "GOOGLE_WIF_PROVIDER_ID",
  "GOOGLE_WIF_SERVICE_ACCOUNT",
  "VERIFICATION_ENABLED",
] as const;

export type VerificationConfigKey = (typeof REQUIRED_VERIFICATION_ENV_KEYS)[number];

/**
 * Kiểm tra SỰ HIỆN DIỆN (không phải giá trị) của các biến môi trường verification
 * cần thiết — an toàn để hiển thị trên UI/log (không bao giờ trả giá trị thật).
 */
export function checkVerificationConfigPresence(
  env: Record<string, string | undefined> = process.env,
): Record<VerificationConfigKey, boolean> {
  const result = {} as Record<VerificationConfigKey, boolean>;
  for (const key of REQUIRED_VERIFICATION_ENV_KEYS) {
    result[key] = Boolean(env[key]?.trim());
  }
  return result;
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

/** Giai đoạn thất bại — verification UI dùng để chẩn đoán chính xác thay vì đoán mò. */
export type CallWorkerStage =
  | "CONFIG"
  | "VERCEL_OIDC"
  | "STS"
  | "GENERATE_ID_TOKEN"
  | "CLOUD_RUN"
  | "WORKER_AUTH"
  | "WORKER_RESPONSE";

export interface CallWorkerResult<T> {
  ok: boolean;
  status: number;
  data: T | { error?: string };
  stage?: CallWorkerStage;
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
 *
 * Trả kèm `stage` để phân biệt lỗi xảy ra ở đâu (CONFIG/VERCEL_OIDC/STS/
 * GENERATE_ID_TOKEN/CLOUD_RUN/WORKER_AUTH/WORKER_RESPONSE) — không bao giờ
 * trả secret/token trong response.
 */
export async function callWorker<T>(
  path: WorkerEndpoint,
  body?: unknown,
  timeoutMs = 120_000,
  options: CallWorkerOptions = {},
): Promise<CallWorkerResult<T>> {
  const { url, secret } = getWorkerConfig();
  if (!url) {
    return { ok: false, status: 503, data: { error: "PDF_MERGE_WORKER_URL chưa cấu hình." }, stage: "CONFIG" };
  }
  // Chỉ chặn lỗi cấu trúc rõ ràng (path bị nối nhầm vào base URL) — KHÔNG áp
  // đặt hostname cụ thể ở đây (callWorker là client chung, dùng được cho mọi
  // worker deployment/local dev). Kiểm tra hostname staging thuộc CONFIG gate
  // riêng (xem checkVerificationConfigPresence + diagnoseWorkerUrl ở route /status).
  const urlDiag = diagnoseWorkerUrl(url);
  if (urlDiag.workerPath) {
    return { ok: false, status: 503, data: { error: urlDiag.error ?? undefined }, stage: "CONFIG" };
  }

  const method = WORKER_METHODS[path];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (getGcpWifConfig()) {
      // Cloud Run IAM auth: Authorization mang Google ID token.
      const tokenResult = await getCloudRunIdToken(url, options.request);
      if ("error" in tokenResult) {
        return { ok: false, status: 502, data: { error: tokenResult.error }, stage: tokenResult.stage };
      }
      headers.Authorization = `Bearer ${tokenResult.idToken}`;
      if (secret) headers["X-Merge-Worker-Secret"] = secret;
    } else if (secret) {
      headers.Authorization = `Bearer ${secret}`;
    }

    let res: Response;
    try {
      res = await fetch(`${url}${path}`, {
        method,
        headers,
        body: method === "GET" ? undefined : body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        data: { error: `Không kết nối được Cloud Run: ${error instanceof Error ? error.message : String(error)}` },
        stage: "CLOUD_RUN",
      };
    }
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) {
      // 401/403 = Cloud Run IAM hoặc app secret từ chối. 404 = route/host sai
      // (base URL trỏ nhầm chỗ, hoặc bị nối thừa path). Còn lại = worker đã
      // nhận request nhưng xử lý lỗi (business logic).
      const stage: CallWorkerStage = res.status === 401 || res.status === 403
        ? "WORKER_AUTH"
        : res.status === 404
          ? "CLOUD_RUN"
          : "WORKER_RESPONSE";
      return { ok: false, status: res.status, data, stage };
    }
    return { ok: true, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}
