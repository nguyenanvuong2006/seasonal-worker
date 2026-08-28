/**
 * Unit tests for MergeStageTimer + fetchWithTimeout (stage observability and
 * the bounded-fetch guard that turns a hung Google API call into a visible,
 * caught error instead of a serverless function killed mid-flight).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MergeStageTimer, fetchWithTimeout } from "./merge-timing.ts";

test("MergeStageTimer aggregates stage durations into the report buckets (PII-free)", async () => {
  const timer = new MergeStageTimer("job-x");
  await timer.measure("DATA_LOAD", async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
  await timer.measure("GOOGLE_API", async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
  await timer.measure("DRIVE_PDF", async () => {
    await new Promise((r) => setTimeout(r, 5));
  });

  const s = timer.summary();
  assert.equal(typeof s.DATA_LOAD_MS, "number");
  assert.ok((s.DATA_LOAD_MS ?? 0) >= 5);
  // DRIVE_PDF rolls into the GOOGLE_API_MS one-number bucket.
  assert.ok((s.GOOGLE_API_MS ?? 0) >= 10);
  assert.equal(typeof s.TOTAL_MS, "number");
});

test("MergeStageTimer.measure records timing even when the stage throws", async () => {
  const timer = new MergeStageTimer("job-y");
  await assert.rejects(
    timer.measure("DOCUMENT_RENDER", async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error("boom");
    }),
    /boom/,
  );
  const s = timer.summary();
  assert.ok((s.RENDER_MS ?? 0) >= 5, "stage duration recorded despite failure");
});

test("fetchWithTimeout aborts a hung request and throws a visible timeout error", async () => {
  // A server that never responds; client aborts long before any default.
  const server = await import("node:http").then((http) =>
    http.createServer((_req, res) => {
      // Never call res.end() — simulate a hung Google endpoint.
      setTimeout(() => res.end(), 30_000);
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    await assert.rejects(
      fetchWithTimeout(`http://127.0.0.1:${port}/hung`, {}, 200),
      /Google API request timed out after 200ms/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchWithTimeout returns the response for a fast request", async () => {
  const server = await import("node:http").then((http) =>
    http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/ok`, {}, 2_000);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
