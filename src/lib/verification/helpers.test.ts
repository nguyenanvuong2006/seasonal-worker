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

test("callWorker with WIF configured uses GET /health with Google token and secret header", async () => {
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
  assert.equal(headers.Authorization, "Bearer google-id-token");
  assert.equal(headers["X-Merge-Worker-Secret"], "secret");
});

test("callWorker with WIF configured uses POST /run with Google token and JSON body", async () => {
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
  assert.equal(headers.Authorization, "Bearer google-id-token");
  assert.equal(headers["X-Merge-Worker-Secret"], "secret");
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

test("callWorker: HTTP 404 from Cloud Run is reported as stage CLOUD_RUN with safe diagnostics", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 404 })) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.stage, "CLOUD_RUN");
});

test("callWorker: HTTP 403 from Cloud Run IAM is reported as stage WORKER_AUTH", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 403 })) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.stage, "WORKER_AUTH");
});

test("callWorker: worker-level 500 is reported as stage WORKER_RESPONSE (not CLOUD_RUN)", async () => {
  process.env.PDF_MERGE_WORKER_URL = "https://worker.example";
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "render failed" }), { status: 500 })) as typeof fetch;

  const result = await callWorker("/health");

  assert.equal(result.ok, false);
  assert.equal(result.stage, "WORKER_RESPONSE");
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
