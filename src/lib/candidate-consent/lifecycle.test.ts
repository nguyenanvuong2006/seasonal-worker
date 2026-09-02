import test from "node:test";
import assert from "node:assert/strict";
import {
  canConfirm,
  canRevoke,
  canView,
  isTerminal,
  nextStatusOnView,
  sessionCanAccessApplication,
  TERMINAL_STATUSES,
  type CandidateDocumentStatus,
} from "./lifecycle.ts";

const ALL_STATUSES: CandidateDocumentStatus[] = [
  "GENERATING",
  "READY",
  "ISSUED",
  "VIEWED",
  "CONFIRMED",
  "REVOKED",
  "SUPERSEDED",
  "EXPIRED",
  "FAILED",
];

test("canView: only ISSUED/VIEWED/CONFIRMED are viewable", () => {
  const viewable = ALL_STATUSES.filter(canView);
  assert.deepEqual(viewable.sort(), ["CONFIRMED", "ISSUED", "VIEWED"].sort());
});

test("canView: GENERATING and FAILED are never viewable (no document exists yet / generation broke)", () => {
  assert.equal(canView("GENERATING"), false);
  assert.equal(canView("FAILED"), false);
});

test("canView: REVOKED/SUPERSEDED/EXPIRED are never viewable (dead document)", () => {
  assert.equal(canView("REVOKED"), false);
  assert.equal(canView("SUPERSEDED"), false);
  assert.equal(canView("EXPIRED"), false);
});

test("canConfirm: only ISSUED/VIEWED — a document must exist and not already be confirmed/dead", () => {
  const confirmable = ALL_STATUSES.filter(canConfirm);
  assert.deepEqual(confirmable.sort(), ["ISSUED", "VIEWED"].sort());
});

test("canConfirm: CONFIRMED cannot be confirmed again (idempotency boundary — duplicate confirm must be rejected here)", () => {
  assert.equal(canConfirm("CONFIRMED"), false);
});

test("canConfirm: REVOKED document can never be confirmed", () => {
  assert.equal(canConfirm("REVOKED"), false);
});

test("canConfirm: SUPERSEDED document can never be confirmed (must confirm the NEW version instead)", () => {
  assert.equal(canConfirm("SUPERSEDED"), false);
});

test("canRevoke: only READY/ISSUED/VIEWED — never after CONFIRMED (history must not be erased)", () => {
  assert.equal(canRevoke("CONFIRMED"), false);
});

test("canRevoke: cannot revoke an already-revoked or superseded document", () => {
  assert.equal(canRevoke("REVOKED"), false);
  assert.equal(canRevoke("SUPERSEDED"), false);
});

test("nextStatusOnView: ISSUED -> VIEWED on first open", () => {
  assert.equal(nextStatusOnView("ISSUED"), "VIEWED");
});

test("nextStatusOnView: VIEWED stays VIEWED (idempotent — re-opening doesn't regress state)", () => {
  assert.equal(nextStatusOnView("VIEWED"), "VIEWED");
});

test("nextStatusOnView: CONFIRMED never regresses to VIEWED", () => {
  assert.equal(nextStatusOnView("CONFIRMED"), "CONFIRMED");
});

test("isTerminal: matches exactly TERMINAL_STATUSES, nothing more nothing less", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(isTerminal(status), (TERMINAL_STATUSES as string[]).includes(status));
  }
});

test("sessionCanAccessApplication: allows when active, unexpired, and the application is in scope", () => {
  const session = { revokedAtMs: null, expiresAtMs: 1000, scopedApplicationIds: ["app-1", "app-2"] };
  assert.equal(sessionCanAccessApplication(session, "app-1", 500), true);
});

test("sessionCanAccessApplication: denies candidate A's session reading candidate B's application (IDOR)", () => {
  const session = { revokedAtMs: null, expiresAtMs: 1000, scopedApplicationIds: ["app-1"] };
  assert.equal(sessionCanAccessApplication(session, "app-B-not-scoped", 500), false);
});

test("sessionCanAccessApplication: denies once expired, even for an in-scope application", () => {
  const session = { revokedAtMs: null, expiresAtMs: 1000, scopedApplicationIds: ["app-1"] };
  assert.equal(sessionCanAccessApplication(session, "app-1", 1000), false);
  assert.equal(sessionCanAccessApplication(session, "app-1", 1500), false);
});

test("sessionCanAccessApplication: denies once revoked, even before the natural expiry", () => {
  const session = { revokedAtMs: 100, expiresAtMs: 100_000, scopedApplicationIds: ["app-1"] };
  assert.equal(sessionCanAccessApplication(session, "app-1", 200), false);
});

test("sessionCanAccessApplication: empty scope denies everything (fail closed, never fail open)", () => {
  const session = { revokedAtMs: null, expiresAtMs: 1000, scopedApplicationIds: [] };
  assert.equal(sessionCanAccessApplication(session, "app-1", 500), false);
});
