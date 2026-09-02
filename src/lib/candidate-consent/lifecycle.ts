/**
 * CANDIDATE DOCUMENT LIFECYCLE — pure state-machine guards.
 *
 * GENERATING -> READY -> ISSUED -> VIEWED -> CONFIRMED
 *                                       \-> REVOKED (before CONFIRMED, staff-only)
 *   any non-terminal -> SUPERSEDED (a correction replaces it with a new document)
 *   any non-terminal -> EXPIRED (optional TTL policy, not currently scheduled)
 *   GENERATING -> FAILED (generation error)
 *
 * GENERATING -> READY and READY -> ISSUED are TWO SEPARATE, write-side-only
 * business events (see finalize/route.ts) — never a side effect of a GET:
 *   READY   = the individual PDF exists, is immutable, and is hashed
 *             (pdf_sha256 + storage pointer both persisted).
 *   ISSUED  = staff/system explicitly released that exact READY document to
 *             the candidate (a distinct write + its own audit event, even
 *             when it happens moments after READY in the same request).
 *
 * CONFIRMED, REVOKED, SUPERSEDED, EXPIRED, FAILED are terminal — no
 * transition function in this module ever returns a status that used to be
 * one of those, only checks whether an action is allowed FROM the current
 * status (the DB row's status itself is never mutated backward by design:
 * every write path in the API layer re-checks the CURRENT DB row, this
 * module documents/encodes the rule so both server code and tests share one
 * source of truth instead of duplicating the state table).
 */

export type CandidateDocumentStatus =
  | "GENERATING"
  | "READY"
  | "ISSUED"
  | "VIEWED"
  | "CONFIRMED"
  | "REVOKED"
  | "SUPERSEDED"
  | "EXPIRED"
  | "FAILED";

export const TERMINAL_STATUSES: readonly CandidateDocumentStatus[] = [
  "CONFIRMED",
  "REVOKED",
  "SUPERSEDED",
  "EXPIRED",
  "FAILED",
];

export function isTerminal(status: CandidateDocumentStatus): boolean {
  return (TERMINAL_STATUSES as string[]).includes(status);
}

/** Candidate may open/read the PDF while it is any of these — never while GENERATING/READY/FAILED or after REVOKED/SUPERSEDED/EXPIRED. */
const VIEWABLE_STATUSES: readonly CandidateDocumentStatus[] = ["ISSUED", "VIEWED", "CONFIRMED"];
export function canView(status: CandidateDocumentStatus): boolean {
  return (VIEWABLE_STATUSES as string[]).includes(status);
}

/**
 * Candidate may confirm ONLY from VIEWED — a server-proven view
 * (nextStatusOnView, driven by the pdf route actually serving bytes) is a
 * hard prerequisite, never inferred from client state. ISSUED-but-never-
 * opened can NOT be confirmed; CONFIRMED can not be confirmed again.
 */
const CONFIRMABLE_STATUSES: readonly CandidateDocumentStatus[] = ["VIEWED"];
export function canConfirm(status: CandidateDocumentStatus): boolean {
  return (CONFIRMABLE_STATUSES as string[]).includes(status);
}

/** Staff may revoke only before a confirmation exists and before the document is already dead. */
const REVOCABLE_STATUSES: readonly CandidateDocumentStatus[] = ["READY", "ISSUED", "VIEWED"];
export function canRevoke(status: CandidateDocumentStatus): boolean {
  return (REVOCABLE_STATUSES as string[]).includes(status);
}

/** GENERATING -> READY: write-side only, requires the finalizer to have a hashed artifact in hand (checked by the caller, not here). */
export function canFinalizeToReady(status: CandidateDocumentStatus): boolean {
  return status === "GENERATING";
}

/** READY -> ISSUED: write-side only, explicit staff/system release. */
export function canIssue(status: CandidateDocumentStatus): boolean {
  return status === "READY";
}

/** First server-proven view transitions ISSUED -> VIEWED; re-viewing an already-VIEWED/CONFIRMED doc is a no-op read (never regresses). */
export function nextStatusOnView(status: CandidateDocumentStatus): CandidateDocumentStatus {
  return status === "ISSUED" ? "VIEWED" : status;
}

export interface AccessSessionScope {
  revokedAtMs: number | null;
  expiresAtMs: number;
  scopedApplicationIds: readonly string[];
}

/**
 * IDOR guard: is this session, at `nowMs`, allowed to touch a document that
 * belongs to `documentApplicationId`? Every one of these must hold — this
 * function is the single choke point both the view and confirm routes call,
 * so "candidate A cannot access candidate B's document" is proven once here
 * and re-used, not re-implemented per-route.
 *
 * This is scope-membership only (was the application in scope at
 * verification time) — it deliberately says nothing about the document's
 * CURRENT lifecycle status. Callers MUST separately re-check the document's
 * live status (canView/canConfirm against a FRESH DB read) on every request:
 * a session snapshot from login time must never be trusted as still-current
 * authorization for a document that was revoked/superseded/expired since.
 */
export function sessionCanAccessApplication(
  session: AccessSessionScope,
  documentApplicationId: string,
  nowMs: number,
): boolean {
  if (session.revokedAtMs !== null) return false;
  if (nowMs >= session.expiresAtMs) return false;
  return session.scopedApplicationIds.includes(documentApplicationId);
}
