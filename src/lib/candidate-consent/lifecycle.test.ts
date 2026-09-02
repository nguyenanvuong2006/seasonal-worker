import test from "node:test";
import assert from "node:assert/strict";
import {
  canConfirm,
  canFinalizeToReady,
  canIssue,
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

test("canConfirm: ONLY VIEWED — a server-proven view is required, ISSUED-but-never-opened cannot be confirmed", () => {
  const confirmable = ALL_STATUSES.filter(canConfirm);
  assert.deepEqual(confirmable, ["VIEWED"]);
});

test("canConfirm: ISSUED (not yet viewed) is rejected — confirmation must require a server-proven VIEWED state", () => {
  assert.equal(canConfirm("ISSUED"), false);
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

test("canFinalizeToReady: only from GENERATING (write-side finalizer transition)", () => {
  const finalizable = ALL_STATUSES.filter(canFinalizeToReady);
  assert.deepEqual(finalizable, ["GENERATING"]);
});

test("canIssue: only from READY (explicit staff/system release, never skips the READY gate)", () => {
  const issuable = ALL_STATUSES.filter(canIssue);
  assert.deepEqual(issuable, ["READY"]);
});

test("canIssue: GENERATING cannot be issued directly — must reach READY (hashed artifact) first", () => {
  assert.equal(canIssue("GENERATING"), false);
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

/* ============================================================ *
 * COMBINED RACE SCENARIOS — exactly what the pdf/confirm routes compute on
 * every request: sessionCanAccessApplication(session, ...) (scope, from
 * verification time) AND canView/canConfirm(FRESH doc.status) (from a
 * live DB read). A still-valid session must NOT grant access once the
 * document's OWN status has moved on since login — these tests simulate
 * that exact interleaving using the same two functions the routes call.
 * ============================================================ */

test("RACE: candidate verifies identity, staff revokes the document, candidate's still-valid session then tries to view it -> DENIED", () => {
  // Session itself is still perfectly valid (not expired/revoked) — only
  // the DOCUMENT changed underneath it. The route's fresh status read must
  // be what blocks access, not the session.
  const session = { revokedAtMs: null, expiresAtMs: 100_000, scopedApplicationIds: ["app-1"] };
  const inScope = sessionCanAccessApplication(session, "app-1", 500);
  const documentStatusAfterRevoke: CandidateDocumentStatus = "REVOKED";
  assert.equal(inScope, true, "the session itself is still valid and in-scope");
  assert.equal(canView(documentStatusAfterRevoke), false, "but the FRESH document status must deny the view");
});

test("RACE: candidate verifies identity, staff reissues (supersedes) the document, candidate's still-valid session tries the OLD document -> DENIED", () => {
  const session = { revokedAtMs: null, expiresAtMs: 100_000, scopedApplicationIds: ["app-1"] };
  const inScope = sessionCanAccessApplication(session, "app-1", 500);
  const oldDocumentStatusAfterSupersede: CandidateDocumentStatus = "SUPERSEDED";
  assert.equal(inScope, true);
  assert.equal(canView(oldDocumentStatusAfterSupersede), false, "the superseded (old) document must never be viewable again");
  assert.equal(canConfirm(oldDocumentStatusAfterSupersede), false, "and must never be confirmable");
});

test("RACE: document is revoked AFTER the candidate already viewed it but BEFORE confirming -> confirm is DENIED even though VIEWED was reached honestly", () => {
  // Simulates: view succeeds (status->VIEWED), then staff revokes for a
  // correction, THEN the candidate's already-open tab submits confirm.
  const statusAtConfirmTime: CandidateDocumentStatus = "REVOKED"; // staff revoked between view and confirm
  assert.equal(canConfirm(statusAtConfirmTime), false);
});
