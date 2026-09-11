/**
 * Unit tests for MergeStageTimer + fetchWithTimeout (stage observability and
 * the bounded-fetch guard that turns a hung Google API call into a visible,
 * caught error instead of a serverless function killed mid-flight).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MergeStageTimer, fetchWithTimeout } from "./merge-timing.ts";

/**
 * Deterministic fake clock injected into MergeStageTimer instead of the real
 * wall clock. `Date.now()`-based timing around a `setTimeout(..., 5)` was
 * flaky under system load / clock-resolution rounding — a "5ms" timer can
 * legitimately be observed as <5ms elapsed depending on scheduler jitter.
 * Advancing a fake counter synchronously inside `measure()`'s callback makes
 * the recorded duration exact and independent of real time entirely, while
 * still exercising the same measure()/summary() logic under test.
 */
function makeFakeClock(startAt = 1_000) {
  let now = startAt;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test("MergeStageTimer aggregates stage durations into the report buckets (PII-free)", async () => {
  const clock = makeFakeClock();
  const timer = new MergeStageTimer("job-x", clock.now);
  await timer.measure("DATA_LOAD", async () => {
    clock.advance(5);
  });
  await timer.measure("GOOGLE_API", async () => {
    clock.advance(5);
  });
  await timer.measure("DRIVE_PDF", async () => {
    clock.advance(5);
  });

  const s = timer.summary();
  assert.equal(s.DATA_LOAD_MS, 5);
  // DRIVE_PDF rolls into the GOOGLE_API_MS one-number bucket.
  assert.equal(s.GOOGLE_API_MS, 10);
  assert.equal(s.TOTAL_MS, 15);
});

test("MergeStageTimer.measure records timing even when the stage throws", async () => {
  const clock = makeFakeClock();
  const timer = new MergeStageTimer("job-y", clock.now);
  await assert.rejects(
    timer.measure("DOCUMENT_RENDER", async () => {
      clock.advance(5);
      throw new Error("boom");
    }),
    /boom/,
  );
  const s = timer.summary();
  assert.equal(s.RENDER_MS, 5, "stage duration recorded despite failure");
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
