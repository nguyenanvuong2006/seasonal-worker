import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  callWorker,
  isVerificationEnabled,
  diagnoseWorkerUrl,
  checkVerificationConfigPresence,
  EXPECTED_STAGING_WORKER_HOSTNAME,
} from "./helpers.ts";
import { clearGcpTokenCache } from "./gcp-oidc.ts";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.PDF_MERGE_WORKER_URL;
const originalSecret = process.env.MERGE_WORKER_SECRET;

const originalWifEnv: Record<string, string | undefined> = {};
for (const k of ["GOOGLE_WIF_PROJECT_NUMBER", "GOOGLE_WIF_POOL_ID", "GOOGLE_WIF_PROVIDER_ID", "GOOGLE_WIF_SERVICE_ACCOUNT"]) {
  originalWifEnv[k] = process.env[k];
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.PDF_MERGE_WORKER_URL;
  else process.env.PDF_MERGE_WORKER_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.MERGE_WORKER_SECRET;
  else process.env.MERGE_WORKER_SECRET = originalSecret;
  for (const [k, v] of Object.entries(originalWifEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearGcpTokenCache();
});

function captureFetch() {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

test("callWorker uses GET without a body for /health", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example/";
  process.env.MERGE_WORKER_SECRET = "secret";
  const calls = captureFetch();

  await callWorker("/health");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://worker.example/health");
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.body, undefined);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer secret");
});

test("callWorker uses POST with JSON body for /run", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  const calls = captureFetch();

  await callWorker("/run", { jobId: "job-1" });

  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.body, JSON.stringify({ jobId: "job-1" }));
});

test("callWorker uses POST for /verify-visual and /benchmark", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  const calls = captureFetch();

  await callWorker("/verify-visual", { jobId: "job-1" });
  await callWorker("/benchmark", { counts: [1, 10] });

  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[1].init?.method, "POST");
});

test("callWorker omits Authorization when worker secret is empty", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  delete process.env.MERGE_WORKER_SECRET;
  const calls = captureFetch();

  await callWorker("/health");

  assert.equal("Authorization" in (calls[0].init?.headers as Record<string, string>), false);
});


function setWifEnv() {
  process.env.GOOGLE_WIF_PROJECT_NUMBER = "68054464426";
  process.env.GOOGLE_WIF_POOL_ID = "vercel-staging";
  process.env.GOOGLE_WIF_PROVIDER_ID = "vercel-preview";
  process.env.GOOGLE_WIF_SERVICE_ACCOUNT = "seasonal-worker-merge@seasonal-worker-505710.iam.gserviceaccount.com";
}

function mockOidcRoutes() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://sts.googleapis.com/")) {
      return new Response(JSON.stringify({ access_token: "fed-access-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("https://iamcredentials.googleapis.com/")) {
      return new Response(JSON.stringify({ token: "google-id-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("https://worker.example/")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

test("callWorker with WIF configured uses GET /health with ID token in X-Serverless-Authorization and secret in Authorization (2 independent headers, no clash)", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example/";
  process.env.MERGE_WORKER_SECRET = "secret";
  setWifEnv();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).startsWith("https://sts.googleapis.com/")) {
      return new Response(JSON.stringify({ access_token: "fed-access-token", expires_in: 3600 }), { status: 200 });
    }
    if (String(input).startsWith("https://iamcredentials.googleapis.com/")) {
      return new Response(JSON.stringify({ token: "google-id-token" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const req = new Request("https://app.example", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
  const result = await callWorker("/health", undefined, 10_000, { request: req });

  assert.equal(result.ok, true);
  const workerCall = calls.find((c) => c.url === "https://worker.example/health");
  assert.ok(workerCall, "worker /health should be called");
  assert.equal(workerCall.init?.method, "GET");
  assert.equal(workerCall.init?.body, undefined);
  const headers = workerCall.init?.headers as Record<string, string>;
  // Cloud Run IAM layer — Google ID token, NEVER Authorization (that's the app's own header now).
  assert.equal(headers["X-Serverless-Authorization"], "Bearer google-id-token");
  // App-level layer — canonical path is Authorization.
  assert.equal(headers.Authorization, "Bearer secret");
  // X-Merge-Worker-Secret kept only for backward compat with older worker deployments.
  assert.equal(headers["X-Merge-Worker-Secret"], "secret");
  assert.equal(result.diagnostics?.cloudRunAuthHeaderPresent, true);
  assert.equal(result.diagnostics?.appAuthHeaderPresent, true);
});

test("callWorker with WIF configured uses POST /run with the same 2-header split and JSON body", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  process.env.MERGE_WORKER_SECRET = "secret";
  setWifEnv();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).startsWith("https://sts.googleapis.com/")) {
      return new Response(JSON.stringify({ access_token: "fed", expires_in: 3600 }), { status: 200 });
    }
    if (String(input).startsWith("https://iamcredentials.googleapis.com/")) {
      return new Response(JSON.stringify({ token: "google-id-token" }), { status: 200 });
    }
    return new Response(JSON.stringify({ processed: 1 }), { status: 200 });
  }) as typeof fetch;

  const req = new Request("https://app.example", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
  const result = await callWorker("/run", { jobId: "job-1" }, 10_000, { request: req });

  assert.equal(result.ok, true);
  const workerCall = calls.find((c) => c.url === "https://worker.example/run");
  assert.ok(workerCall);
  assert.equal(workerCall.init?.method, "POST");
  assert.equal(workerCall.init?.body, JSON.stringify({ jobId: "job-1" }));
  const headers = workerCall.init?.headers as Record<string, string>;
  assert.equal(headers["X-Serverless-Authorization"], "Bearer google-id-token");
  assert.equal(headers.Authorization, "Bearer secret");
});

test("callWorker: ID token audience is the Cloud Run service origin (host only, no path)", async () => {
  process.env.PDF_MERGE_WORKER_URL = `https://${EXPECTED_STAGING_WORKER_HOSTNAME}`;
  process.env.MERGE_WORKER_SECRET = "secret";
  setWifEnv();
  const iamCalls: Array<{ body: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://sts.googleapis.com/")) {
      return new Response(JSON.stringify({ access_token: "fed", expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith("https://iamcredentials.googleapis.com/")) {
      iamCalls.push({ body: String(init?.body) });
      return new Response(JSON.stringify({ token: "google-id-token" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const req = new Request("https://app.example", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
  await callWorker("/run", { jobId: "job-1" }, 10_000, { request: req });

  assert.equal(iamCalls.length, 1);
  const audience = JSON.parse(iamCalls[0].body).audience;
  assert.equal(audience, `https://${EXPECTED_STAGING_WORKER_HOSTNAME}`);
  assert.equal(new URL(audience).pathname, "/", "audience must be the service origin, never /run or /health");
});

test("callWorker with WIF configured uses POST for /verify-visual and /benchmark", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  setWifEnv();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).startsWith("https://sts.googleapis.com/")) {
      return new Response(JSON.stringify({ access_token: "fed", expires_in: 3600 }), { status: 200 });
    }
    if (String(input).startsWith("https://iamcredentials.googleapis.com/")) {
      return new Response(JSON.stringify({ token: "google-id-token" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const req = new Request("https://app.example", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
  await callWorker("/verify-visual", { referencePdfBase64: "abc" }, 10_000, { request: req });
  await callWorker("/benchmark", { counts: [1, 10] }, 10_000, { request: req });

  const visual = calls.find((c) => c.url === "https://worker.example/verify-visual");
  const bench = calls.find((c) => c.url === "https://worker.example/benchmark");
  assert.equal(visual?.init?.method, "POST");
  assert.equal(bench?.init?.method, "POST");
});

test("callWorker returns 502 with STS error when WIF exchange fails", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  process.env.MERGE_WORKER_SECRET = "secret";
  setWifEnv();
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).startsWith("https://sts.googleapis.com/")) {
      return new Response(JSON.stringify({ error_description: "Invalid subject token" }), { status: 401 });
    }
    throw new Error("Unexpected fetch");
  }) as typeof fetch;

  const req = new Request("https://app.example", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
  const result = await callWorker("/health", undefined, 10_000, { request: req });

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.stage, "STS");
  assert.match((result.data as { error?: string }).error ?? "", /STS token exchange failed/);
});

test("callWorker returns GENERATE_ID_TOKEN stage when iamcredentials.generateIdToken fails", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  process.env.MERGE_WORKER_SECRET = "secret";
  setWifEnv();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://sts.googleapis.com/")) {
      return new Response(JSON.stringify({ access_token: "fed", expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith("https://iamcredentials.googleapis.com/")) {
      return new Response(JSON.stringify({ error: { message: "Permission denied" } }), { status: 403 });
    }
    throw new Error("Unexpected fetch");
  }) as typeof fetch;

  const req = new Request("https://app.example", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
  const result = await callWorker("/health", undefined, 10_000, { request: req });

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.stage, "GENERATE_ID_TOKEN");
  assert.match((result.data as { error?: string }).error ?? "", /generateIdToken failed/);
});

test("callWorker returns 503 without calling fetch when URL is missing", async () => {
  delete process.env.PDF_MERGE_WORKER_URL;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response();
  }) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.stage, "CONFIG");
});

// ---------------------------------------------------------------
// isVerificationEnabled — regression tests for the "disappearing
// Verification tab" bug class: Vercel Preview always runs with
// NODE_ENV=production, so gating on NODE_ENV alone (or treating a missing
// VERCEL_ENV as "assume production") would wrongly disable Verification on
// Preview. VERCEL_ENV must be checked first/authoritatively.
// ---------------------------------------------------------------

test("isVerificationEnabled: enabled on Preview even though NODE_ENV=production (Vercel always builds with NODE_ENV=production)", () => {
  assert.equal(
    isVerificationEnabled({ VERIFICATION_ENABLED: "true", VERCEL_ENV: "preview", NODE_ENV: "production" }),
    true,
  );
});

test("isVerificationEnabled: disabled when VERCEL_ENV=production regardless of the flag", () => {
  assert.equal(
    isVerificationEnabled({ VERIFICATION_ENABLED: "true", VERCEL_ENV: "production" }),
    false,
  );
});

test("isVerificationEnabled: disabled when the flag itself is false", () => {
  assert.equal(
    isVerificationEnabled({ VERIFICATION_ENABLED: "false", VERCEL_ENV: "preview" }),
    false,
  );
});

test("isVerificationEnabled: fails closed outside Vercel (no VERCEL_ENV) when NODE_ENV=production", () => {
  assert.equal(
    isVerificationEnabled({ VERIFICATION_ENABLED: "true", NODE_ENV: "production" }),
    false,
  );
});

test("isVerificationEnabled: enabled locally (no VERCEL_ENV, NODE_ENV=development)", () => {
  assert.equal(
    isVerificationEnabled({ VERIFICATION_ENABLED: "true", NODE_ENV: "development" }),
    true,
  );
});

// ---------------------------------------------------------------
// diagnoseWorkerUrl — Cloud Run base URL normalization/validation.
// ---------------------------------------------------------------

test("diagnoseWorkerUrl: reports not configured when PDF_MERGE_WORKER_URL is empty", () => {
  const diag = diagnoseWorkerUrl("");
  assert.equal(diag.configured, false);
  assert.match(diag.error ?? "", /chưa cấu hình/);
});

test("diagnoseWorkerUrl: accepts the expected staging base URL with no path", () => {
  const diag = diagnoseWorkerUrl(`https://${EXPECTED_STAGING_WORKER_HOSTNAME}`);
  assert.equal(diag.workerHost, EXPECTED_STAGING_WORKER_HOSTNAME);
  assert.equal(diag.workerPath, "");
  assert.equal(diag.hostnameMatchesExpectedStaging, true);
  assert.equal(diag.error, null);
});

test("diagnoseWorkerUrl: strips only a trailing slash — bare root is not treated as an extra path", () => {
  const diag = diagnoseWorkerUrl(`https://${EXPECTED_STAGING_WORKER_HOSTNAME}/`);
  assert.equal(diag.workerPath, "");
  assert.equal(diag.error, null);
});

test("diagnoseWorkerUrl: flags CONFIG error when /health was mistakenly appended to the env var", () => {
  const diag = diagnoseWorkerUrl(`https://${EXPECTED_STAGING_WORKER_HOSTNAME}/health`);
  assert.equal(diag.workerPath, "/health");
  assert.match(diag.error ?? "", /base URL/);
});

test("diagnoseWorkerUrl: flags CONFIG error when hostname does not match the expected staging service", () => {
  const diag = diagnoseWorkerUrl("https://some-other-service-12345.asia-southeast1.run.app");
  assert.equal(diag.hostnameMatchesExpectedStaging, false);
  assert.equal(diag.error, "PDF_MERGE_WORKER_URL does not point to the expected staging Cloud Run service");
});

test("checkVerificationConfigPresence: reports booleans only, never values", () => {
  const presence = checkVerificationConfigPresence({
    PDF_MERGE_WORKER_URL: "https://worker.example",
    MERGE_WORKER_SECRET: "super-secret-value",
    VERIFICATION_ENABLED: "true",
  });
  assert.equal(presence.PDF_MERGE_WORKER_URL, true);
  assert.equal(presence.MERGE_WORKER_SECRET, true);
  assert.equal(presence.GOOGLE_WIF_PROJECT_NUMBER, false);
  assert.equal(JSON.stringify(presence).includes("super-secret-value"), false);
});

// ---------------------------------------------------------------
// callWorker — stage classification for Cloud Run responses.
// ---------------------------------------------------------------

// Worker THẬT (worker/src/index.ts) luôn set Content-Type: application/json
// cho MỌI response nó tự tạo ra — kể cả lỗi auth 401 ({error:"unauthorized"}).
// Cloud Run IAM (Google), khi tự chặn request TRƯỚC KHI chạm tới code worker,
// trả về trang lỗi của Google — KHÔNG phải JSON. Đây là bằng chứng thực tế để
// phân biệt 2 lớp auth độc lập, không đoán từ status code (401/403 dùng
// chung ở cả 2 lớp).
const JSON_HEADERS = { "Content-Type": "application/json" };

test("callWorker: HTTP 404 from the worker's own JSON response is reported as stage WORKER_RESPONSE (Cloud Run itself never 404s by path)", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: JSON_HEADERS })) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.stage, "WORKER_RESPONSE");
});

test("callWorker: HTTP 401/403 with the worker's own JSON error body is reported as stage WORKER_AUTH (request reached the app; app-level secret rejected it)", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_HEADERS })) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.stage, "WORKER_AUTH");
});

test("callWorker: HTTP 401/403 WITHOUT a JSON body is reported as stage CLOUD_RUN_IAM (Google's own front door rejected the ID token before reaching the app)", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  // Google trả text/html (trang lỗi) hoặc không set content-type — không phải JSON của worker.
  globalThis.fetch = (async () =>
    new Response("<html>Unauthorized</html>", { status: 401, headers: { "Content-Type": "text/html" } })) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.stage, "CLOUD_RUN_IAM");
});

test("callWorker: worker-level 500 is reported as stage WORKER_RESPONSE", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "render failed" }), { status: 500, headers: JSON_HEADERS })) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(result.ok, false);
  assert.equal(result.stage, "WORKER_RESPONSE");
});

test("callWorker: network failure reaching Cloud Run is reported as stage WORKER_REQUEST", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  globalThis.fetch = (async () => {
    throw new Error("fetch failed: ECONNREFUSED");
  }) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.stage, "WORKER_REQUEST");
});

test("callWorker: diagnostics never include the secret/token value, only booleans/hostnames", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  process.env.MERGE_WORKER_SECRET = "super-secret-value";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS })) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(result.diagnostics?.workerHost, "worker.example");
  assert.equal(result.diagnostics?.workerSecretConfigured, true);
  assert.equal(result.diagnostics?.cloudRunAuthHeaderPresent, false); // no GOOGLE_WIF_* configured
  assert.equal(result.diagnostics?.appAuthHeaderPresent, true); // secret sent via Authorization
  assert.equal(JSON.stringify(result.diagnostics).includes("super-secret-value"), false);
});

test("callWorker: with WIF configured but MERGE_WORKER_SECRET missing in Vercel, diagnostics prove Cloud Run IAM succeeded and only the app-level credential is absent", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  delete process.env.MERGE_WORKER_SECRET; // the staging misconfiguration this test locks in a diagnostic for
  setWifEnv();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://sts.googleapis.com/")) {
      return new Response(JSON.stringify({ access_token: "fed", expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith("https://iamcredentials.googleapis.com/")) {
      return new Response(JSON.stringify({ token: "google-id-token" }), { status: 200 });
    }
    // Worker: Cloud Run IAM đã pass (X-Serverless-Authorization hợp lệ) nhưng
    // KHÔNG có Authorization (app secret) → app tự chặn, trả JSON của chính nó.
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }) as typeof fetch;

  const req = new Request("https://app.example", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });
  const result = await callWorker("/run", { jobId: "job-1" }, 10_000, { request: req });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.stage, "WORKER_AUTH");
  assert.equal(result.diagnostics?.workerSecretConfigured, false);
  assert.equal(result.diagnostics?.appAuthHeaderPresent, false); // no secret configured -> Authorization never sent
  assert.equal(result.diagnostics?.cloudRunAuthHeaderPresent, true); // ID token WAS sent — proves Cloud Run IAM layer was fine
});

test("callWorker: rejects a URL with a path baked in as CONFIG (never sends the malformed request)", async () => {
  process.env.PDF_MERGE_WORKER_URL = `https://${EXPECTED_STAGING_WORKER_HOSTNAME}/health`;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response();
  }) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(called, false);
  assert.equal(result.stage, "CONFIG");
});
