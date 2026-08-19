import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { callWorker } from "./helpers";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.PDF_MERGE_WORKER_URL;
const originalSecret = process.env.MERGE_WORKER_SECRET;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.PDF_MERGE_WORKER_URL;
  else process.env.PDF_MERGE_WORKER_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.MERGE_WORKER_SECRET;
  else process.env.MERGE_WORKER_SECRET = originalSecret;
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
