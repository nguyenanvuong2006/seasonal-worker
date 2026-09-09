import test from "node:test";
import assert from "node:assert/strict";
import { formatConfirmedAt, abbreviateHash, statusPresentation } from "./verification-display.ts";

test("formatConfirmedAt renders in Asia/Ho_Chi_Minh, not the host/server timezone", () => {
  // 2026-09-09T10:20:44Z = 17:20:44 in Asia/Ho_Chi_Minh (UTC+7).
  const formatted = formatConfirmedAt("2026-09-09T10:20:44.000Z");
  assert.match(formatted, /17:20:44/);
  assert.match(formatted, /09\/09\/2026/);
});

test("formatConfirmedAt never throws on a bad input", () => {
  assert.equal(formatConfirmedAt("not-a-date"), "—");
});

test("abbreviateHash shortens a 64-char SHA-256 with an ellipsis, never re-exposes the middle", () => {
  const hash = "0123456789abcdef".repeat(4); // 64 chars
  const abbrev = abbreviateHash(hash);
  assert.equal(abbrev, "01234567…89abcdef");
  assert.ok(!abbrev.includes(hash.slice(20, 40)), "middle section must never appear in the abbreviated form");
});

test("abbreviateHash leaves a short value untouched", () => {
  assert.equal(abbreviateHash("short"), "short");
});

test("statusPresentation never claims a certificate/CA-signed digital signature for VALID", () => {
  const p = statusPresentation("VALID");
  assert.equal(p.label, "Hợp lệ");
  assert.equal(p.tone, "green");
  assert.doesNotMatch(p.description, /chữ ký số|ký số CA|chứng thực|cơ quan nhà nước/i);
});

test("statusPresentation covers every status the verification service can return", () => {
  for (const status of ["VALID", "REVOKED", "SUPERSEDED", "INVALID", "NOT_FOUND"] as const) {
    const p = statusPresentation(status);
    assert.ok(p.label.length > 0);
    assert.ok(p.description.length > 0);
  }
});
