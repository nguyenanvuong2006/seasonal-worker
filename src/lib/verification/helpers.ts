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
  | "CLOUD_RUN_IAM"
  | "WORKER_AUTH"
  | "WORKER_REQUEST"
  | "WORKER_RESPONSE";

/**
 * Chẩn đoán an toàn — CHỈ boolean/hostname, KHÔNG bao giờ chứa secret/token
 * value. Dùng để phân biệt "Cloud Run IAM từ chối" (CLOUD_RUN_IAM, request
 * chưa tới được code worker) với "worker nhận request nhưng app-level auth
 * từ chối" (WORKER_AUTH) — 2 lớp auth ĐỘC LẬP, tách hẳn 2 header (xem
 * callWorker) nên 401 ở lớp nào cũng không thể suy ra chỉ từ status code.
 */
export interface CallWorkerDiagnostics {
  workerHost: string | null;
  /** Audience dùng khi lấy Google ID token (= workerHost khi có GOOGLE_WIF_*). */
  tokenAudienceHost: string | null;
  /** Có gửi X-Serverless-Authorization (Google ID token, lớp Cloud Run IAM) không. */
  cloudRunAuthHeaderPresent: boolean;
  /** Có gửi Authorization (app secret, lớp worker) không. */
  appAuthHeaderPresent: boolean;
  /** MERGE_WORKER_SECRET có được cấu hình ở phía Vercel (server) hay không. */
  workerSecretConfigured: boolean;
}

export interface CallWorkerResult<T> {
  ok: boolean;
  status: number;
  data: T | { error?: string };
  stage?: CallWorkerStage;
  diagnostics?: CallWorkerDiagnostics;
}

/**
 * Gọi worker endpoint (server-side).
 *
 * Auth 2 LỚP ĐỘC LẬP, mỗi lớp 1 header RIÊNG — không còn tranh chấp
 * `Authorization` giữa 2 lớp (đây chính là nguyên nhân 401 trước đây: khi có
 * GOOGLE_WIF_*, ID token chiếm `Authorization`, app secret chỉ còn nằm ở
 * header phụ `X-Merge-Worker-Secret` — nếu worker đang chạy PHIÊN BẢN CODE
 * chưa biết fallback đó (hoặc chỉ kiểm tra `Authorization`), secret không
 * bao giờ được worker thấy dù đã cấu hình đúng). Theo đúng pattern Cloud Run
 * hỗ trợ cho service cần giữ `Authorization` cho việc riêng của mình:
 *
 * - LỚP 1 — Cloud Run IAM: khi GOOGLE_WIF_* được cấu hình, lấy Google ID
 *   token (aud = worker URL) qua Vercel OIDC → STS → generateIdToken, gửi
 *   trong `X-Serverless-Authorization: Bearer <id_token>` — Cloud Run chấp
 *   nhận header này cho IAM y hệt `Authorization`
 *   (https://cloud.google.com/run/docs/troubleshooting#appropriate-auth).
 *   Nếu Cloud Run tự từ chối token (trước khi request chạm tới code worker),
 *   Google trả trang lỗi của riêng Google — KHÔNG phải JSON do worker tạo ra.
 * - LỚP 2 — app-level: `Authorization: Bearer <MERGE_WORKER_SECRET>` — path
 *   CHÍNH THỨC (canonical), worker (`isAuthorized()`) kiểm tra header này
 *   trước tiên. Cũng gửi kèm `X-Merge-Worker-Secret` (giá trị giống hệt) để
 *   tương thích ngược với bản worker cũ hơn — KHÔNG phải lớp bảo mật thứ 3,
 *   chỉ là 1 secret gửi ở 2 chỗ trong lúc chuyển đổi. Nếu lớp 1 đã pass
 *   nhưng thiếu/sai secret, worker TỰ trả JSON `{error:"unauthorized"}`
 *   (đúng Content-Type application/json worker luôn dùng) — bằng chứng
 *   request ĐÃ tới app.
 *
 * Trả kèm `stage` (CONFIG/VERCEL_OIDC/STS/GENERATE_ID_TOKEN/CLOUD_RUN_IAM/
 * WORKER_AUTH/WORKER_REQUEST/WORKER_RESPONSE) + `diagnostics` an toàn — không
 * bao giờ trả secret/token trong response.
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
    let tokenAudienceHost: string | null = null;

    if (getGcpWifConfig()) {
      // Cloud Run IAM auth — header RIÊNG, không đụng Authorization (app secret dùng header đó).
      const tokenResult = await getCloudRunIdToken(url, options.request);
      if ("error" in tokenResult) {
        return { ok: false, status: 502, data: { error: tokenResult.error }, stage: tokenResult.stage };
      }
      headers["X-Serverless-Authorization"] = `Bearer ${tokenResult.idToken}`;
      tokenAudienceHost = urlDiag.workerHost;
    }
    if (secret) {
      // App secret — path chính thức: Authorization. Gửi kèm X-Merge-Worker-Secret
      // (cùng giá trị) chỉ để tương thích ngược, không phải lớp bảo mật riêng.
      headers.Authorization = `Bearer ${secret}`;
      headers["X-Merge-Worker-Secret"] = secret;
    }

    const diagnostics: CallWorkerDiagnostics = {
      workerHost: urlDiag.workerHost,
      tokenAudienceHost,
      cloudRunAuthHeaderPresent: Boolean(headers["X-Serverless-Authorization"]),
      appAuthHeaderPresent: Boolean(headers.Authorization),
      workerSecretConfigured: Boolean(secret),
    };

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
        stage: "WORKER_REQUEST",
        diagnostics,
      };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) {
      let stage: CallWorkerStage;
      if (res.status === 401 || res.status === 403) {
        // Worker luôn trả JSON (kể cả khi tự từ chối auth) — nếu response
        // KHÔNG phải JSON, request chưa tới được code worker: Cloud Run IAM
        // (Google) đã chặn trước. Đây là bằng chứng thực tế, không đoán từ status.
        stage = contentType.includes("application/json") ? "WORKER_AUTH" : "CLOUD_RUN_IAM";
      } else {
        // 404/500/... đều là worker đã nhận + xử lý request (Cloud Run không
        // 404 theo path — cả service dùng chung 1 container) → business/route lỗi.
        stage = "WORKER_RESPONSE";
      }
      return { ok: false, status: res.status, data, stage, diagnostics };
    }
    return { ok: true, status: res.status, data, diagnostics };
  } finally {
    clearTimeout(timer);
  }
}
