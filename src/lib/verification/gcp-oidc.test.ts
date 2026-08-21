import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  clearGcpTokenCache,
  exchangeFederatedAccessToken,
  generateCloudRunIdToken,
  getCloudRunIdToken,
  getGcpWifConfig,
  getOidcTokenFromRequest,
  stsAudience,
  type GcpWifConfig,
} from "./gcp-oidc.ts";

const originalFetch = globalThis.fetch;
const originalEnv: Record<string, string | undefined> = {};
for (const k of [
  "GOOGLE_WIF_PROJECT_NUMBER",
  "GOOGLE_WIF_POOL_ID",
  "GOOGLE_WIF_PROVIDER_ID",
  "GOOGLE_WIF_SERVICE_ACCOUNT",
  "VERCEL_OIDC_TOKEN",
]) {
  originalEnv[k] = process.env[k];
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearGcpTokenCache();
});

function setWifEnv(overrides: Record<string, string> = {}) {
  process.env.GOOGLE_WIF_PROJECT_NUMBER = "68054464426";
  process.env.GOOGLE_WIF_POOL_ID = "vercel-staging";
  process.env.GOOGLE_WIF_PROVIDER_ID = "vercel-preview";
  process.env.GOOGLE_WIF_SERVICE_ACCOUNT = "seasonal-worker-merge@seasonal-worker-505710.iam.gserviceaccount.com";
  Object.assign(process.env, overrides);
}

const CFG: GcpWifConfig = {
  projectNumber: "68054464426",
  poolId: "vercel-staging",
  providerId: "vercel-preview",
  serviceAccount: "seasonal-worker-merge@seasonal-worker-505710.iam.gserviceaccount.com",
};

/** Mock fetch route theo URL; mặc định lỗi nếu gặp URL lạ. */
function mockFetch(routes: Record<string, () => Response | Promise<Response>>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("getGcpWifConfig returns null when any variable is missing", () => {
  delete process.env.GOOGLE_WIF_PROJECT_NUMBER;
  assert.equal(getGcpWifConfig(), null);
  setWifEnv();
  assert.deepEqual(getGcpWifConfig(), CFG);
});

test("getGcpWifConfig: KHÔNG có default/fallback cho bất kỳ biến nào — thiếu env = null, không âm thầm dùng giá trị của môi trường khác (staging)", () => {
  // Đây chính là bằng chứng "Production không thể vô tình dùng credential
  // staging": code không hardcode bất kỳ giá trị fallback nào cho 4 biến
  // WIF — mọi giá trị PHẢI đến từ chính process.env của deployment đang
  // chạy (Vercel scope biến môi trường theo environment — Production/
  // Preview có process.env RIÊNG, code này không tự trộn 2 nguồn).
  for (const key of ["GOOGLE_WIF_PROJECT_NUMBER", "GOOGLE_WIF_POOL_ID", "GOOGLE_WIF_PROVIDER_ID", "GOOGLE_WIF_SERVICE_ACCOUNT"] as const) {
    setWifEnv();
    delete process.env[key];
    assert.equal(getGcpWifConfig(), null, `thiếu ${key} phải trả null, không fallback về giá trị nào khác`);
  }
});

test("getCloudRunIdToken: KHÔNG bao giờ đọc GOOGLE_APPLICATION_CREDENTIALS / service-account key tĩnh — set biến đó không ảnh hưởng flow", async () => {
  // Chứng minh "no static GCP service-account key is required": toàn bộ
  // flow chỉ dùng Vercel OIDC token (header/env) + STS + generateIdToken —
  // set 1 biến kiểu credential-file KHÔNG được phép làm thay đổi hành vi.
  setWifEnv();
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/should-be-ignored.json";
  try {
    mockFetch({
      "https://sts.googleapis.com/": () => jsonResponse({ access_token: "fed-access-token", expires_in: 3600 }),
      "https://iamcredentials.googleapis.com/": () => jsonResponse({ token: "google-id-token" }),
    });
    const req = new Request("https://example.com", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
    const result = await getCloudRunIdToken("https://worker.run.app", req);
    assert.deepEqual(result, { idToken: "google-id-token" }, "flow vẫn thành công qua đúng đường OIDC→STS→generateIdToken, không rẽ nhánh nào đọc credential file");
  } finally {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
});

test("stsAudience uses workload identity pool provider resource name", () => {
  assert.equal(
    stsAudience(CFG),
    "//iam.googleapis.com/projects/68054464426/locations/global/workloadIdentityPools/vercel-staging/providers/vercel-preview",
  );
});

test("getOidcTokenFromRequest prefers x-vercel-oidc-token header then env", () => {
  const req = new Request("https://example.com", { headers: { "x-vercel-oidc-token": "header-token" } });
  assert.equal(getOidcTokenFromRequest(req), "header-token");
  delete process.env.VERCEL_OIDC_TOKEN;
  assert.equal(getOidcTokenFromRequest(undefined), null);
  process.env.VERCEL_OIDC_TOKEN = "env-token";
  assert.equal(getOidcTokenFromRequest(undefined), "env-token");
});

test("exchangeFederatedAccessToken POSTs to STS with correct audience and returns access token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ access_token: "fed-access-token", expires_in: 3600 });
  }) as typeof fetch;

  const result = await exchangeFederatedAccessToken("oidc-jwt", CFG);

  assert.equal(calls[0]?.url, "https://sts.googleapis.com/v1/token");
  assert.equal(calls[0]?.init?.method, "POST");
  const body = new URLSearchParams(String(calls[0]?.init?.body));
  assert.equal(body.get("audience"), stsAudience(CFG));
  assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(body.get("requested_token_type"), "urn:ietf:params:oauth:token-type:access_token");
  assert.equal(body.get("scope"), "https://www.googleapis.com/auth/cloud-platform");
  assert.equal(body.get("subject_token_type"), "urn:ietf:params:oauth:token-type:jwt");
  assert.equal(body.get("subject_token"), "oidc-jwt");
  assert.equal(result.accessToken, "fed-access-token");
});

test("exchangeFederatedAccessToken surfaces STS failure", async () => {
  mockFetch({
    "https://sts.googleapis.com/": () =>
      jsonResponse({ error_description: "Invalid subject token" }, 400),
  });
  await assert.rejects(
    () => exchangeFederatedAccessToken("bad", CFG),
    /STS token exchange failed \(HTTP 400\): Invalid subject token/,
  );
});

test("generateCloudRunIdToken POSTs to iamcredentials with audience and Bearer federated token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ token: "google-id-token" });
  }) as typeof fetch;

  const result = await generateCloudRunIdToken("fed-token", CFG.serviceAccount, "https://worker.run.app");

  assert.equal(
    calls[0]?.url,
    "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/seasonal-worker-merge%40seasonal-worker-505710.iam.gserviceaccount.com:generateIdToken",
  );
  assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer fed-token");
  assert.equal(JSON.parse(String(calls[0]?.init?.body)).audience, "https://worker.run.app");
  assert.equal(result.idToken, "google-id-token");
});

test("generateCloudRunIdToken surfaces API failure", async () => {
  mockFetch({
    "https://iamcredentials.googleapis.com/": () =>
      jsonResponse({ error: { message: "Permission denied on resource" } }, 403),
  });
  await assert.rejects(
    () => generateCloudRunIdToken("fed", CFG.serviceAccount, "https://worker.run.app"),
    /generateIdToken failed \(HTTP 403\): Permission denied on resource/,
  );
});

test("getCloudRunIdToken full flow: OIDC → STS → generateIdToken → cached id token", async () => {
  setWifEnv();
  const calls: string[] = [];
  mockFetch({
    "https://sts.googleapis.com/": () => {
      calls.push("sts");
      return jsonResponse({ access_token: "fed-access-token", expires_in: 3600 });
    },
    "https://iamcredentials.googleapis.com/": () => {
      calls.push("iam");
      return jsonResponse({ token: "google-id-token" });
    },
  });

  const req = new Request("https://example.com", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
  const first = await getCloudRunIdToken("https://worker.run.app", req);
  assert.deepEqual(first, { idToken: "google-id-token" });
  assert.deepEqual(calls, ["sts", "iam"]);

  // Lần 2 (cache) — không gọi lại STS/IAM.
  const second = await getCloudRunIdToken("https://worker.run.app", req);
  assert.deepEqual(second, { idToken: "google-id-token" });
  assert.deepEqual(calls, ["sts", "iam"]);
});

test("getCloudRunIdToken returns error when WIF env missing", async () => {
  delete process.env.GOOGLE_WIF_PROJECT_NUMBER;
  const result = await getCloudRunIdToken("https://worker.run.app");
  assert.ok("error" in result);
  assert.equal(result.stage, "CONFIG");
  assert.match(result.error, /GOOGLE_WIF_/);
});

test("getCloudRunIdToken returns error when OIDC token missing", async () => {
  setWifEnv();
  delete process.env.VERCEL_OIDC_TOKEN;
  const result = await getCloudRunIdToken("https://worker.run.app", new Request("https://example.com"));
  assert.ok("error" in result);
  assert.equal(result.stage, "VERCEL_OIDC");
  assert.match(result.error, /x-vercel-oidc-token/);
});

test("getCloudRunIdToken returns error when STS exchange fails", async () => {
  setWifEnv();
  mockFetch({
    "https://sts.googleapis.com/": () => jsonResponse({ error_description: "Invalid token" }, 401),
  });
  const req = new Request("https://example.com", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
  const result = await getCloudRunIdToken("https://worker.run.app", req);
  assert.ok("error" in result);
  assert.equal(result.stage, "STS");
  assert.match(result.error, /STS token exchange failed \(HTTP 401\)/);
});

test("getCloudRunIdToken returns error when generateIdToken fails (audience = Cloud Run base URL)", async () => {
  setWifEnv();
  const calls: string[] = [];
  mockFetch({
    "https://sts.googleapis.com/": () => jsonResponse({ access_token: "fed-access-token", expires_in: 3600 }),
    "https://iamcredentials.googleapis.com/": () => {
      calls.push("iam");
      return jsonResponse({ error: { message: "Permission denied" } }, 403);
    },
  });
  const req = new Request("https://example.com", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
  const result = await getCloudRunIdToken("https://worker.run.app", req);
  assert.ok("error" in result);
  assert.equal(result.stage, "GENERATE_ID_TOKEN");
  assert.match(result.error, /generateIdToken failed \(HTTP 403\)/);
  assert.deepEqual(calls, ["iam"]);
});
