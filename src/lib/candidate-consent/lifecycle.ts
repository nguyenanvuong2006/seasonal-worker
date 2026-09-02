/**
 * CANDIDATE DOCUMENT LIFECYCLE — pure state-machine guards.
 *
 * GENERATING -> READY -> ISSUED -> VIEWED -> CONFIRMED
 *                                       \-> REVOKED (before CONFIRMED, staff-only)
 *   any non-terminal -> SUPERSEDED (a correction replaces it with a new document)
 *   any non-terminal -> EXPIRED (optional TTL policy, not currently scheduled)
 *   GENERATING -> FAILED (generation error)
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

/** Candidate may open/read the PDF while it is any of these — never while GENERATING/FAILED or after REVOKED/SUPERSEDED/EXPIRED. */
const VIEWABLE_STATUSES: readonly CandidateDocumentStatus[] = ["ISSUED", "VIEWED", "CONFIRMED"];
export function canView(status: CandidateDocumentStatus): boolean {
  return (VIEWABLE_STATUSES as string[]).includes(status);
}

/** Candidate may confirm only from ISSUED or VIEWED — never twice (CONFIRMED), never a dead document. */
const CONFIRMABLE_STATUSES: readonly CandidateDocumentStatus[] = ["ISSUED", "VIEWED"];
export function canConfirm(status: CandidateDocumentStatus): boolean {
  return (CONFIRMABLE_STATUSES as string[]).includes(status);
}

/** Staff may revoke only before a confirmation exists and before the document is already dead. */
const REVOCABLE_STATUSES: readonly CandidateDocumentStatus[] = ["READY", "ISSUED", "VIEWED"];
export function canRevoke(status: CandidateDocumentStatus): boolean {
  return (REVOCABLE_STATUSES as string[]).includes(status);
}

/** First view transitions ISSUED -> VIEWED; a later view of an already-VIEWED/CONFIRMED doc is a no-op read. */
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
