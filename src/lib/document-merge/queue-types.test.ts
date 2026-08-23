/**
 * queue-types.ts — pure helpers used by the worker's claim-retry-then-fail-loud
 * logic (runJob in worker/src/index.ts). Pure functions, no DB needed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldRetryClaim, claimRetryDelayMs, WORKER_STAGES, isRetryableItemError } from "./queue-types.ts";

test("shouldRetryClaim: retries while under the max, stops at the max", () => {
  assert.equal(shouldRetryClaim(1, 3), true);
  assert.equal(shouldRetryClaim(2, 3), true);
  assert.equal(shouldRetryClaim(3, 3), false);
  assert.equal(shouldRetryClaim(4, 3), false);
});

test("shouldRetryClaim: defaults to 3 attempts", () => {
  assert.equal(shouldRetryClaim(2), true);
  assert.equal(shouldRetryClaim(3), false);
});

test("claimRetryDelayMs: increases with attempt, capped at 2000ms", () => {
  assert.equal(claimRetryDelayMs(1), 250);
  assert.equal(claimRetryDelayMs(2), 500);
  assert.equal(claimRetryDelayMs(3), 1000);
  assert.equal(claimRetryDelayMs(10), 2000);
});

test("isRetryableItemError: deterministic validation is non-retryable; transient stays retryable", () => {
  assert.equal(isRetryableItemError("INCOMPLETE"), false);
  assert.equal(isRetryableItemError("INVALID_MAPPING"), false);
  assert.equal(isRetryableItemError("INVALID_TEMPLATE"), false);
  assert.equal(isRetryableItemError("UNSUPPORTED_SOURCE_PATH"), false);
  assert.equal(isRetryableItemError("RENDER_FAILED"), true);
  assert.equal(isRetryableItemError(null), true);
  assert.equal(isRetryableItemError("INCOMPLETE", true), true);
  assert.equal(isRetryableItemError("RENDER_FAILED", false), false);
});

test("WORKER_STAGES: contains the full pipeline in order, JOB_CLAIMED first", () => {
  assert.equal(WORKER_STAGES[0], "JOB_CLAIMED");
  assert.equal(WORKER_STAGES[WORKER_STAGES.length - 1], "BATCH_FINALIZE");
  assert.equal(WORKER_STAGES.includes("CHROMIUM_LAUNCH"), true);
  assert.equal(WORKER_STAGES.includes("STORAGE_UPLOAD"), true);
  assert.equal(WORKER_STAGES.includes("HISTORY_WRITE"), true);
  // Không trùng lặp.
  assert.equal(new Set(WORKER_STAGES).size, WORKER_STAGES.length);
});
