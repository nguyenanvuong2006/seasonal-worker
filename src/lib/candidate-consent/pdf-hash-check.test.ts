import test from "node:test";
import assert from "node:assert/strict";
import { computeFileSha256Hex, comparePdfHash } from "./pdf-hash-check.ts";

test("computeFileSha256Hex matches Node's own crypto.createHash for the same bytes", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = new TextEncoder().encode("%PDF-1.4\n%mock pdf bytes for testing\n");
  const expected = createHash("sha256").update(bytes).digest("hex");

  const blob = new Blob([bytes]);
  const computed = await computeFileSha256Hex(blob);
  assert.equal(computed, expected);
  assert.equal(computed.length, 64);
});

test("PDF hash MATCH — computed hash equals the stored confirmation hash (case-insensitive)", () => {
  const hash = "a".repeat(64);
  assert.equal(comparePdfHash(hash, hash), "MATCH");
  assert.equal(comparePdfHash(hash.toUpperCase(), hash), "MATCH");
});

test("PDF hash MISMATCH — a different file's hash never matches", () => {
  assert.equal(comparePdfHash("a".repeat(64), "b".repeat(64)), "MISMATCH");
});

test("a single changed byte in the file changes its SHA-256 entirely (no false MATCH)", async () => {
  const original = await computeFileSha256Hex(new Blob([new TextEncoder().encode("%PDF-1.4\noriginal content")]));
  const tampered = await computeFileSha256Hex(new Blob([new TextEncoder().encode("%PDF-1.4\noriginel content")]));
  assert.notEqual(original, tampered);
  assert.equal(comparePdfHash(tampered, original), "MISMATCH");
});
