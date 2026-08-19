import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { callWorker } from "./helpers.ts";
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
  assert.match((result.data as { error?: string }).error ?? "", /STS token exchange failed/);
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
});
