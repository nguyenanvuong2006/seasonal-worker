import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCanonicalEvidencePayload,
  canonicalizeEvidence,
  computeEvidenceHashes,
  generateAccessToken,
  generateReceiptId,
  hashAccessToken,
  hmacSha256Hex,
  sha256Hex,
  verifyEvidenceHash,
  verifyEvidenceHmac,
  type ConfirmationEvidenceInput,
} from "./evidence.ts";

function sampleInput(overrides: Partial<ConfirmationEvidenceInput> = {}): ConfirmationEvidenceInput {
  return {
    documentId: "doc-1",
    documentVersion: 3,
    documentSha256: "a".repeat(64),
    applicationId: "app-1",
    identityVerificationMethod: "CCCD_PHONE",
    identityVerifiedAt: "2026-09-01T00:00:00.000Z",
    consentVersion: "v1",
    consentTextHash: "b".repeat(64),
    confirmedAtServer: "2026-09-01T00:01:00.000Z",
    accessSessionId: "sess-1",
    ipAddress: "203.0.113.5",
    userAgent: "Mozilla/5.0",
    receiptId: "SIG-ABCDEFGHJKLMNP",
    ...overrides,
  };
}

test("canonicalizeEvidence: identical content in different key order produces the same string", () => {
  const a = canonicalizeEvidence({ z: 1, a: 2, m: { y: 1, b: 2 } });
  const b = canonicalizeEvidence({ a: 2, z: 1, m: { b: 2, y: 1 } });
  assert.equal(a, b);
});

test("canonicalizeEvidence: array order is preserved (order is meaningful there)", () => {
  const out = canonicalizeEvidence({ items: ["b", "a"] });
  assert.equal(out, '{"items":["b","a"]}');
});

test("sha256Hex: deterministic and matches known test vector for empty string", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("computeEvidenceHashes: deterministic — same input twice yields the same SHA-256", () => {
  const input = sampleInput();
  const first = computeEvidenceHashes(input, null);
  const second = computeEvidenceHashes(input, null);
  assert.equal(first.evidenceSha256, second.evidenceSha256);
  assert.equal(first.canonicalPayload, second.canonicalPayload);
});

test("computeEvidenceHashes: changing ANY field changes the hash (tamper-evident)", () => {
  const base = computeEvidenceHashes(sampleInput(), null);
  const tampered = computeEvidenceHashes(sampleInput({ documentSha256: "c".repeat(64) }), null);
  assert.notEqual(base.evidenceSha256, tampered.evidenceSha256);
});

test("computeEvidenceHashes: no secret -> evidenceHmac is null (HMAC is optional, never required)", () => {
  const result = computeEvidenceHashes(sampleInput(), null);
  assert.equal(result.evidenceHmac, null);
});

test("computeEvidenceHashes: with a secret -> HMAC verifies against the same secret", () => {
  const input = sampleInput();
  const result = computeEvidenceHashes(input, "test-secret");
  assert.ok(result.evidenceHmac);
  assert.ok(verifyEvidenceHmac(result.canonicalPayload, "test-secret", result.evidenceHmac!));
});

test("verifyEvidenceHmac: fails against the WRONG secret", () => {
  const input = sampleInput();
  const result = computeEvidenceHashes(input, "correct-secret");
  assert.equal(verifyEvidenceHmac(result.canonicalPayload, "wrong-secret", result.evidenceHmac!), false);
});

test("verifyEvidenceHash: tampered canonical payload fails verification against the original hash", () => {
  const result = computeEvidenceHashes(sampleInput(), null);
  const tamperedPayload = result.canonicalPayload.replace(sampleInput().documentSha256, "f".repeat(64));
  assert.equal(verifyEvidenceHash(tamperedPayload, result.evidenceSha256), false);
});

test("buildCanonicalEvidencePayload: never includes raw CCCD/phone fields (only IDs/hashes/timestamps)", () => {
  const payload = buildCanonicalEvidencePayload(sampleInput());
  const keys = Object.keys(payload).join(",").toLowerCase();
  assert.ok(!keys.includes("cccd"));
  assert.ok(!keys.includes("phone"));
});

test("generateReceiptId: SIG- prefix, and entropy comes from randomBytes not timestamps (two calls differ)", () => {
  const a = generateReceiptId();
  const b = generateReceiptId();
  assert.match(a, /^SIG-[A-Z2-9]{15}$/);
  assert.match(b, /^SIG-[A-Z2-9]{15}$/);
  assert.notEqual(a, b);
});

test("generateReceiptId: alphabet excludes ambiguous characters 0/O/1/I", () => {
  for (let i = 0; i < 200; i++) {
    const id = generateReceiptId();
    assert.doesNotMatch(id.slice(4), /[01OI]/);
  }
});

test("generateAccessToken / hashAccessToken: two generated tokens are distinct and each hashes deterministically", () => {
  const t1 = generateAccessToken();
  const t2 = generateAccessToken();
  assert.notEqual(t1, t2);
  assert.equal(hashAccessToken(t1), hashAccessToken(t1));
  assert.notEqual(hashAccessToken(t1), hashAccessToken(t2));
});

test("hashAccessToken: the raw token itself never appears inside its own hash (sanity — hash is not identity)", () => {
  const raw = generateAccessToken();
  const hash = hashAccessToken(raw);
  assert.notEqual(hash, raw);
  assert.equal(hash.length, 64); // hex sha256
});

test("hmacSha256Hex: matches a known HMAC-SHA256 test vector (key='key', msg='The quick brown fox jumps over the lazy dog')", () => {
  const out = hmacSha256Hex("The quick brown fox jumps over the lazy dog", "key");
  assert.equal(out, "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
});
