/**
 * REGRESSION — GOOGLE_DOCS error classification for the async worker.
 *
 * isTransientGoogleDocsError() decides whether a failed Google Docs/Drive
 * operation may succeed on a queue retry (timeout/network/429/5xx → RETRY
 * with the standard attempt cap) or is deterministic (403/404/config →
 * FAIL immediately so operators see the real problem instead of a spinning
 * queue). Loads the REAL module (pure — no DB, no server-only).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isTransientGoogleDocsError } from "./google-docs-service.ts";

test("timeout / aborted fetches are transient", () => {
  assert.equal(isTransientGoogleDocsError(new Error("Google API request timed out after 30000ms (https://www.googleapis.com/drive…).")), true);
  assert.equal(isTransientGoogleDocsError(new Error("Google API request timed out after 30000ms.")), true);
  assert.equal(isTransientGoogleDocsError(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), true);
});

test("network failures are transient", () => {
  assert.equal(isTransientGoogleDocsError(new Error("fetch failed")), true);
  assert.equal(isTransientGoogleDocsError(new Error("connect ECONNRESET 142.250.0.1:443")), true);
});

test("429 / 5xx are transient (quota + backend blips retry safely)", () => {
  assert.equal(isTransientGoogleDocsError(new Error("Google API 429: Resource has been exhausted")), true);
  assert.equal(isTransientGoogleDocsError(new Error("Google API 502: Bad Gateway")), true);
  assert.equal(isTransientGoogleDocsError(new Error("Google API 503: Service Unavailable")), true);
  assert.equal(isTransientGoogleDocsError(new Error("Google API 500: Internal Error")), true);
});

test("403 / 404 are deterministic — retrying cannot fix permission or missing-resource problems", () => {
  assert.equal(isTransientGoogleDocsError(new Error("Google API 403: The caller does not have permission")), false);
  assert.equal(isTransientGoogleDocsError(new Error("Google API 404: File not found")), false);
});

test("non-Google errors are NOT silently retried", () => {
  assert.equal(isTransientGoogleDocsError(new Error("FORMAT_SOURCE_NOT_FOUND: template snapshot missing")), false);
  assert.equal(isTransientGoogleDocsError(new Error("some unknown local bug")), false);
  assert.equal(isTransientGoogleDocsError(null), false);
});
