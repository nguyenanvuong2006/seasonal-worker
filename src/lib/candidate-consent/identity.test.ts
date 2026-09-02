import test from "node:test";
import assert from "node:assert/strict";
import {
  cccdHmac,
  identityLimiterKey,
  ipLimiterKey,
  maskCccd,
  maskPhone,
  normalizeCccd,
  normalizePhone,
} from "./identity.ts";

test("normalizePhone: strips non-digit characters", () => {
  assert.equal(normalizePhone(" 0912-345 678 "), "0912345678");
});

test("normalizeCccd: trims whitespace only, does not alter digits", () => {
  assert.equal(normalizeCccd("  001234567890  "), "001234567890");
});

test("maskCccd: never reveals the middle digits of a 12-digit CCCD", () => {
  const masked = maskCccd("001234567890");
  assert.equal(masked, "0012****7890");
  assert.ok(!masked.includes("345678"));
});

test("maskPhone: only the last 4 digits are visible", () => {
  assert.equal(maskPhone("0912345678"), "******5678");
});

test("identityLimiterKey: deterministic for the same (cccd, phone, secret)", () => {
  const a = identityLimiterKey("001234567890", "0912345678", "secret");
  const b = identityLimiterKey("001234567890", "0912345678", "secret");
  assert.equal(a, b);
});

test("identityLimiterKey: never contains the raw CCCD or phone as a substring", () => {
  const key = identityLimiterKey("001234567890", "0912345678", "secret");
  assert.ok(!key.includes("001234567890"));
  assert.ok(!key.includes("0912345678"));
  assert.equal(key.length, 64);
});

test("identityLimiterKey: different phone for the same CCCD produces a different key (no cross-talk)", () => {
  const a = identityLimiterKey("001234567890", "0912345678", "secret");
  const b = identityLimiterKey("001234567890", "0987654321", "secret");
  assert.notEqual(a, b);
});

test("identityLimiterKey: different secret produces a different key (not guessable without the server secret)", () => {
  const a = identityLimiterKey("001234567890", "0912345678", "secret-a");
  const b = identityLimiterKey("001234567890", "0912345678", "secret-b");
  assert.notEqual(a, b);
});

test("ipLimiterKey: deterministic and never contains the raw IP", () => {
  const key = ipLimiterKey("203.0.113.5", "secret");
  assert.ok(!key.includes("203.0.113.5"));
  assert.equal(ipLimiterKey("203.0.113.5", "secret"), key);
});

test("cccdHmac: deterministic, non-reversible correlation key (not the raw CCCD)", () => {
  const key = cccdHmac("001234567890", "secret");
  assert.notEqual(key, "001234567890");
  assert.equal(cccdHmac("001234567890", "secret"), key);
});
