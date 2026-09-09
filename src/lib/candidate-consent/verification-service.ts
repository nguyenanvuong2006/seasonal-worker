/**
 * THIRD-PARTY ELECTRONIC-CONFIRMATION VERIFICATION — canonical service.
 * ------------------------------------------------------------------------
 * NOT PKI, NOT a certificate-based digital signature — this proves the SAME
 * tamper-evident evidence record built by the confirm route (see
 * evidence.ts's own docblock) is internally consistent, for a THIRD PARTY
 * who was not present for the original CCCD+phone confirmation flow.
 *
 * Split in two layers, same convention as evidence.ts:
 *   - `evaluatePublicVerification` is a PURE function (no DB, no fetch) that
 *     takes an already-fetched row + the resolved HMAC secret and returns a
 *     safe, PII-free DTO. Fully unit-testable without touching Postgres.
 *   - `verifyByReceiptId` is the thin DB-touching wrapper the public route
 *     calls: one read of document_confirmations (by the opaque, unique,
 *     non-sequential receipt_id — see below), one read of the owning
 *     candidate_documents row, one count of confirmations for that document
 *     (defense in depth for the "exactly one confirmation" invariant the
 *     unique index already enforces), then delegates to the pure function.
 *     ZERO writes to candidate_documents/document_confirmations/audit_logs —
 *     this module never mutates evidence, ever.
 *
 * OPAQUE VERIFICATION ID: reuses `document_confirmations.receipt_id`
 * (generateReceiptId() in evidence.ts — 15 crypto-random bytes through a
 * 33-character alphabet, ~75 bits of entropy, already unique-indexed as
 * `document_confirmation_receipt_uq`) instead of minting a NEW token/column.
 * It is exactly what the mission asks to prefer ("existing non-PII receipt
 * identifier"): non-sequential, unenumerable, never derived from a database
 * row id, and already shown to the candidate on their own success screen —
 * so no migration, no backfill, no new secret is needed for this feature.
 */

import { verifyEvidenceHash, verifyEvidenceHmac, canonicalizeEvidence, buildCanonicalEvidencePayload } from "./evidence.ts";
import { normalizePersonName } from "../person-name.ts";

export type PublicVerificationStatus = "VALID" | "REVOKED" | "SUPERSEDED" | "INVALID" | "NOT_FOUND";

export type IntegrityState = "OK" | "MISMATCH";
export type EvidenceIntegrityState = "VALID" | "INVALID";

/** Everything the pure evaluator needs — already fetched by the DB wrapper. */
export interface VerificationSourceRow {
  candidateDocumentStatus: string; // raw candidate_documents.status
  documentPdfSha256: string | null; // candidate_documents.pdf_sha256
  documentVersion: number | null; // candidate_documents.template_version
  templateName: string | null;
  applicantFullName: string | null;
  applicationId: string;
  revokedAt: string | null; // ISO, only meaningful when status is REVOKED/SUPERSEDED

  receiptId: string;
  confirmedAtServer: string; // ISO
  confirmationPdfSha256: string;
  consentVersion: string;
  consentTextHash: string;
  identityVerificationMethod: string;
  identityVerifiedAt: string; // ISO
  accessSessionId: string;
  ipAddress: string | null;
  userAgent: string | null;
  canonicalEvidenceHash: string;
  evidenceHmac: string | null;
  documentId: string;

  /** How many document_confirmations rows exist for this candidate_document_id — must be exactly 1. */
  confirmationCountForDocument: number;
}

export interface PublicVerificationDto {
  status: PublicVerificationStatus;
  receiptId: string;
  candidateDisplayName: string | null;
  documentName: string | null;
  documentVersion: number | null;
  confirmedAtServer: string;
  verificationMethodLabel: string;
  pdfSha256: string;
  documentIntegrityState: IntegrityState;
  evidenceIntegrityState: EvidenceIntegrityState;
  technicalAccessEvidencePresent: boolean;
  revokedAt: string | null;
}

const VERIFICATION_METHOD_LABELS: Record<string, string> = {
  CCCD_PHONE: "Xác thực qua CCCD & số điện thoại đã đăng ký",
};

export function verificationMethodLabel(method: string): string {
  return VERIFICATION_METHOD_LABELS[method] ?? "Xác thực điện tử";
}

/**
 * Re-derives the canonical evidence payload from the SAME fields the
 * confirmation was built from (never trusts a stored hash blindly — mirrors
 * verifyEvidence() in evidence.ts, but this module owns its own lifecycle
 * -> public-status mapping on top, which evidence.ts intentionally does not
 * know about).
 */
export function evaluatePublicVerification(
  row: VerificationSourceRow,
  hmacSecret: string | null,
): PublicVerificationDto {
  const canonicalPayload = canonicalizeEvidence(
    buildCanonicalEvidencePayload({
      documentId: row.documentId,
      documentVersion: row.documentVersion,
      documentSha256: row.confirmationPdfSha256,
      applicationId: row.applicationId,
      identityVerificationMethod: row.identityVerificationMethod,
      identityVerifiedAt: row.identityVerifiedAt,
      consentVersion: row.consentVersion,
      consentTextHash: row.consentTextHash,
      confirmedAtServer: row.confirmedAtServer,
      accessSessionId: row.accessSessionId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      receiptId: row.receiptId,
    }),
  );

  // "receipt id exists" / "server confirmation timestamp exists" / "consent
  // evidence exists" — schema NOT NULL already guarantees these; re-asserted
  // here anyway as an explicit, testable guard (defense in depth against a
  // future schema relaxation, per the mission's own checklist).
  const requiredFieldsPresent = Boolean(
    row.receiptId && row.confirmedAtServer && row.consentVersion && row.consentTextHash,
  );

  // "confirmation evidence is bound to same pdf_sha256" — the confirmation's
  // OWN recorded pdf_sha256 must match the document's current, immutable
  // pdf_sha256 (both are set once and never mutated in the existing flow;
  // a mismatch here can only mean tampering, never a legitimate state).
  const docShaMatches = Boolean(row.documentPdfSha256) && row.documentPdfSha256 === row.confirmationPdfSha256;
  const documentIntegrityState: IntegrityState =
    docShaMatches && row.confirmationCountForDocument === 1 ? "OK" : "MISMATCH";

  const sha256Matches = verifyEvidenceHash(canonicalPayload, row.canonicalEvidenceHash);
  // Fail closed: no secret in Production (or no stored HMAC at all) means
  // evidence integrity can never be PROVEN valid, so it is treated as
  // INVALID rather than silently skipped — never the same as "valid".
  const hmacMatches =
    hmacSecret !== null && row.evidenceHmac !== null
      ? verifyEvidenceHmac(canonicalPayload, hmacSecret, row.evidenceHmac)
      : false;
  const evidenceIntegrityState: EvidenceIntegrityState =
    sha256Matches && hmacMatches && requiredFieldsPresent ? "VALID" : "INVALID";

  let status: PublicVerificationStatus;
  if (documentIntegrityState === "MISMATCH" || evidenceIntegrityState === "INVALID") {
    // Tampered/broken evidence is surfaced as INVALID regardless of the
    // document's lifecycle status — a corrupted record must never be
    // masked behind a REVOKED/SUPERSEDED label that implies "this used to
    // be fine, then something ordinary happened to it".
    status = "INVALID";
  } else if (row.candidateDocumentStatus === "REVOKED") {
    status = "REVOKED";
  } else if (row.candidateDocumentStatus === "SUPERSEDED") {
    status = "SUPERSEDED";
  } else {
    // CONFIRMED is the normal case. Any other non-terminal status paired
    // with an existing, intact confirmation row is treated the same way —
    // the confirmation record (proven intact above) is the ground truth of
    // "was this confirmed", not a possibly-stale lifecycle column.
    status = "VALID";
  }

  return {
    status,
    receiptId: row.receiptId,
    candidateDisplayName: row.applicantFullName ? normalizePersonName(row.applicantFullName) : null,
    documentName: row.templateName,
    documentVersion: row.documentVersion,
    confirmedAtServer: row.confirmedAtServer,
    verificationMethodLabel: verificationMethodLabel(row.identityVerificationMethod),
    pdfSha256: row.confirmationPdfSha256,
    documentIntegrityState,
    evidenceIntegrityState,
    technicalAccessEvidencePresent: Boolean(row.ipAddress || row.userAgent),
    revokedAt: row.revokedAt,
  };
}

/**
 * The exact public verification URL a QR code / printed receipt encodes.
 * Deliberately just the base URL + receiptId — no query string, no
 * fragment, nothing else ever appended, so a forwarded/scanned QR can never
 * leak more than the same public page a human would type in by hand.
 */
export function buildVerificationUrl(baseUrl: string, receiptId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/xac-thuc-ho-so/${encodeURIComponent(receiptId)}`;
}
