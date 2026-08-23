/**
 * TEST H / TEST I — retry semantics for the canonical pipeline.
 *
 * H: a configuration/validation failure (INCOMPLETE, and the new
 *    CANONICAL_* codes) is terminal — retrying cannot fix it.
 * I: a transient Chromium/storage failure stays retryable with backoff.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_ATTEMPTS,
  NON_RETRYABLE_ERROR_CODES,
  isRetryableItemError,
  retryBackoffSeconds,
  shouldRetry,
} from "./queue-types.ts";
import { CANONICAL_ERROR } from "./canonical-document.ts";

test("TEST H: INCOMPLETE is non-retryable", () => {
  assert.equal(isRetryableItemError("INCOMPLETE"), false);
  assert.equal((NON_RETRYABLE_ERROR_CODES as readonly string[]).includes("INCOMPLETE"), true);
});

test("TEST H: canonical configuration errors are non-retryable", () => {
  for (const code of [CANONICAL_ERROR.NOT_PUBLISHED, CANONICAL_ERROR.SNAPSHOT_EMPTY]) {
    assert.equal(isRetryableItemError(code), false, `${code} must never be retried`);
    assert.equal((NON_RETRYABLE_ERROR_CODES as readonly string[]).includes(code), true);
  }
});

test("TEST H: a non-retryable error fails on the very first attempt", () => {
  for (const code of [
    "INCOMPLETE",
    CANONICAL_ERROR.NOT_PUBLISHED,
    CANONICAL_ERROR.SNAPSHOT_EMPTY,
  ]) {
    const retryable = isRetryableItemError(code);
    // failItem() computes: retryable && shouldRetry(attempt) ? RETRY : FAILED
    const wouldRetry = retryable && shouldRetry(1, DEFAULT_MAX_ATTEMPTS);
    assert.equal(wouldRetry, false, `${code} must be terminal at attempt 1`);
  }
});

test("TEST I: transient Chromium / storage failures remain retryable", () => {
  for (const code of [
    "CHROMIUM_LAUNCH_FAILED",
    "PDF_RENDER_TIMEOUT",
    "STORAGE_UPLOAD_FAILED",
    "STORAGE_TIMEOUT",
    "ECONNRESET",
    null,
    undefined,
  ]) {
    assert.equal(isRetryableItemError(code), true, `${String(code)} must stay retryable`);
  }
});

test("TEST I: retryable transient errors retry with growing backoff until max attempts", () => {
  assert.equal(shouldRetry(1, DEFAULT_MAX_ATTEMPTS), true);
  assert.equal(shouldRetry(DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS), false);

  const first = retryBackoffSeconds(1);
  const later = retryBackoffSeconds(3);
  assert.ok(first >= 0);
  assert.ok(later >= first, "backoff must not shrink as attempts grow");
});

test("an explicit retryable=false overrides the code table (worker fail-closed path)", () => {
  assert.equal(isRetryableItemError("CHROMIUM_LAUNCH_FAILED", false), false);
  assert.equal(isRetryableItemError("INCOMPLETE", true), true);
});
