/**
 * POST /read-stored-pdf — structural regression tests (2026-09, candidate-
 * facing blank-PDF worker-fallback fix, same class of fix as PR #162's
 * /export-doc-pdf and /drive-upload-pdf). Reads the real worker source and
 * asserts the specific safety wiring is present — same "read the real
 * production source" pattern as routes-wiring.test.ts on the Vercel side;
 * this repo has no existing HTTP-level test harness for the worker's own
 * endpoints (the other proxy endpoints /export-doc-pdf, /drive-upload-pdf,
 * /read-google-doc have none either), so this follows that precedent rather
 * than introducing a new one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function sliceEndpoint(pathname: string): string {
  const start = source.indexOf(`url.pathname === "${pathname}"`);
  assert.ok(start > -1, `endpoint ${pathname} must exist`);
  const nextEndpointMarker = source.indexOf('url.pathname === "', start + pathname.length + 20);
  return source.slice(start, nextEndpointMarker > -1 ? nextEndpointMarker : start + 2000);
}

test("/read-stored-pdf requires isAuthorized() — same app-level gate as every other worker endpoint", () => {
  const block = sliceEndpoint("/read-stored-pdf");
  assert.match(block, /if \(!isAuthorized\(req\)\)/);
});

test("/read-stored-pdf requires a non-empty `key` in the body — never proceeds with an arbitrary/blank identifier", () => {
  const block = sliceEndpoint("/read-stored-pdf");
  assert.match(block, /const key = String\(body\.key \?\? ""\)\.trim\(\)/);
  assert.match(block, /if \(!key\) \{/);
});

test("/read-stored-pdf reuses getStorageProvider().get(key) verbatim — no new storage/auth mechanism, no raw Drive file-id parameter", () => {
  const block = sliceEndpoint("/read-stored-pdf");
  assert.match(block, /getStorageProvider\(\)/);
  assert.match(block, /storage\.get\(key\)/);
  assert.doesNotMatch(block, /docId/, "must accept a storage KEY (our own namespace), never a raw Google Drive file/doc id");
});

test("/read-stored-pdf response never includes a credential/token field — only pdfBase64/byteLength or a generic error", () => {
  const block = sliceEndpoint("/read-stored-pdf");
  assert.doesNotMatch(block, /access_token|refresh_token|client_secret/i);
  assert.match(block, /pdfBase64/);
});

test("/read-stored-pdf caps the returned artifact size — matches the same 20MB bound as /drive-upload-pdf's accepted upload size", () => {
  const block = sliceEndpoint("/read-stored-pdf");
  assert.match(block, /20_000_000/);
});

test("/read-stored-pdf is a read-only proxy — never calls storage.put/write anywhere in its own handler block", () => {
  const block = sliceEndpoint("/read-stored-pdf");
  assert.doesNotMatch(block, /storage\.put\(/);
});
