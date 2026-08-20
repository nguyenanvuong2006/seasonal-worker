/**
 * Vercel OIDC → Google Cloud Workload Identity Federation → Cloud Run ID token.
 *
 * Flow (theo Vercel docs "Connect to GCP - OIDC" + Google WIF/Cloud Run pattern):
 *   1. Lấy Vercel OIDC token:
 *      - Vercel Functions: header request `x-vercel-oidc-token`
 *        (docs: https://vercel.com/docs/oidc/reference — Functions nhận token qua
 *        header này; builds/local qua env VERCEL_OIDC_TOKEN).
 *      - Fallback: env `VERCEL_OIDC_TOKEN`.
 *   2. Exchange qua Google STS (https://sts.googleapis.com/v1/token) với
 *      audience = workload identity pool provider resource name
 *      (`//iam.googleapis.com/projects/{PROJECT_NUMBER}/locations/global/
 *        workloadIdentityPools/{POOL}/providers/{PROVIDER}`)
 *      → federated OAuth2 access token.
 *   3. Gọi IAM Credentials API `projects.serviceAccounts.generateIdToken`
 *      (endpoint hỗ trợ trực tiếp federated token) với
 *      audience = Cloud Run service URL → Google-issued ID token.
 *   4. Gửi ID token trong `X-Serverless-Authorization: Bearer <id_token>` tới
 *      Cloud Run — Cloud Run chấp nhận header này y hệt `Authorization` cho
 *      IAM (dùng khi app cần giữ `Authorization` cho auth riêng, xem
 *      callWorker() ở helpers.ts). Cloud Run (--no-allow-unauthenticated) chỉ
 *      chấp nhận Google-issued ID token có aud khớp service URL.
 *
 * IAM cần (service-level, xem docs/STAGING-VERIFICATION-RUNBOOK.md mục GCP):
 *   - principal/principalSet của pool (environment=preview) có
 *     roles/iam.serviceAccountTokenCreator trên service account impersonate.
 *   - service account đó có roles/run.invoker trên Cloud Run service staging.
 *
 * Module này CHỈ chạy server-side (không bao giờ gửi token/secret về client).
 */

export interface GcpWifConfig {
  projectNumber: string;
  poolId: string;
  providerId: string;
  serviceAccount: string;
}

/** Đọc cấu hình WIF từ env. Trả null nếu thiếu bất kỳ biến nào (không guess). */
export function getGcpWifConfig(
  env: Record<string, string | undefined> = process.env,
): GcpWifConfig | null {
  const projectNumber = env.GOOGLE_WIF_PROJECT_NUMBER?.trim();
  const poolId = env.GOOGLE_WIF_POOL_ID?.trim();
  const providerId = env.GOOGLE_WIF_PROVIDER_ID?.trim();
  const serviceAccount = env.GOOGLE_WIF_SERVICE_ACCOUNT?.trim();
  if (!projectNumber || !poolId || !providerId || !serviceAccount) return null;
  return { projectNumber, poolId, providerId, serviceAccount };
}

/** STS audience = workload identity pool provider resource name (dạng //iam.googleapis.com/...). */
export function stsAudience(cfg: GcpWifConfig): string {
  return `//iam.googleapis.com/projects/${cfg.projectNumber}/locations/global/workloadIdentityPools/${cfg.poolId}/providers/${cfg.providerId}`;
}

/**
 * Lấy Vercel OIDC token từ request (header `x-vercel-oidc-token` — cách Vercel
 * Functions nhận token) hoặc env `VERCEL_OIDC_TOKEN` (builds/local).
 */
export function getOidcTokenFromRequest(request?: Request): string | null {
  if (request) {
    const header = request.headers.get("x-vercel-oidc-token");
    if (header) return header;
  }
  const envToken = process.env.VERCEL_OIDC_TOKEN?.trim();
  return envToken || null;
}

/** Bước 2 — STS token exchange: Vercel OIDC JWT → federated Google access token. */
export async function exchangeFederatedAccessToken(
  oidcToken: string,
  cfg: GcpWifConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    audience: stsAudience(cfg),
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "https://www.googleapis.com/auth/cloud-platform",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: oidcToken,
  });
  const res = await fetchImpl("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      `STS token exchange failed (HTTP ${res.status}): ${data.error_description ?? res.statusText}`,
    );
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 3600 };
}

/** Bước 3 — generateIdToken: federated token → Google ID token (aud = Cloud Run URL). */
export async function generateCloudRunIdToken(
  federatedToken: string,
  serviceAccount: string,
  audience: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ idToken: string }> {
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(
    serviceAccount,
  )}:generateIdToken`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${federatedToken}`,
    },
    body: JSON.stringify({ audience, includeEmail: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    token?: string;
    error?: { message?: string };
  };
  if (!res.ok || !data.token) {
    throw new Error(
      `generateIdToken failed (HTTP ${res.status}): ${data.error?.message ?? res.statusText}`,
    );
  }
  return { idToken: data.token };
}

/** Cache ngắn (50 phút; token sống ~1h) — tránh STS exchange cho từng request khi warm. */
const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000;
let cached: { audience: string; idToken: string; expiresAt: number } | null = null;

export function clearGcpTokenCache(): void {
  cached = null;
}

/** Giai đoạn thất bại trong flow Vercel OIDC → STS → generateIdToken (dùng để chẩn đoán). */
export type CloudRunTokenStage = "CONFIG" | "VERCEL_OIDC" | "STS" | "GENERATE_ID_TOKEN";

export type CloudRunTokenResult = { idToken: string } | { error: string; stage: CloudRunTokenStage };

/**
 * Lấy Google ID token (aud = Cloud Run URL) cho Vercel Preview.
 * Trả {error, stage} nếu thiếu config/token hoặc exchange thất bại — KHÔNG fallback
 * về app secret (Cloud Run IAM sẽ từ chối token không phải Google). `stage` cho biết
 * chính xác bước nào thất bại (CONFIG/VERCEL_OIDC/STS/GENERATE_ID_TOKEN) để verification
 * UI hiển thị chẩn đoán rõ ràng — không đoán mò "IAM sai" khi thực ra là bước khác.
 */
export async function getCloudRunIdToken(
  workerUrl: string,
  request?: Request,
): Promise<CloudRunTokenResult> {
  const cfg = getGcpWifConfig();
  if (!cfg) {
    return {
      error: "GOOGLE_WIF_* chưa cấu hình (GOOGLE_WIF_PROJECT_NUMBER/POOL_ID/PROVIDER_ID/SERVICE_ACCOUNT).",
      stage: "CONFIG",
    };
  }
  const oidcToken = getOidcTokenFromRequest(request);
  if (!oidcToken) {
    return {
      error: "Thiếu Vercel OIDC token (header x-vercel-oidc-token). Bật OIDC Federation trong Vercel project settings.",
      stage: "VERCEL_OIDC",
    };
  }
  if (cached && cached.audience === workerUrl && cached.expiresAt > Date.now()) {
    return { idToken: cached.idToken };
  }
  let accessToken: string;
  try {
    ({ accessToken } = await exchangeFederatedAccessToken(oidcToken, cfg));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), stage: "STS" };
  }
  try {
    const { idToken } = await generateCloudRunIdToken(accessToken, cfg.serviceAccount, workerUrl);
    cached = { audience: workerUrl, idToken, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS };
    return { idToken };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), stage: "GENERATE_ID_TOKEN" };
  }
}
