/**
 * ZERO-COST ELECTRONIC-CONSENT EVIDENCE — pure canonicalization/hashing.
 *
 * NOT PKI, NOT a digital certificate/signature. This is a deterministic,
 * tamper-evident evidence record: a canonical JSON payload, its SHA-256, and
 * (when a server secret is available) an HMAC-SHA256 over the same payload —
 * built entirely from Node's built-in `crypto`, no paid provider.
 *
 * Canonicalization matters: naive `JSON.stringify` on an object is NOT
 * deterministic across key insertion order, so two logically-identical
 * evidence payloads could hash differently. `canonicalizeEvidence` sorts
 * object keys recursively (arrays keep their order — order is meaningful
 * there) before stringifying, so the hash is a pure function of content.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function sortKeysDeep(value: CanonicalValue): CanonicalValue {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic JSON string: same content -> same bytes, regardless of input key order. */
export function canonicalizeEvidence(payload: Record<string, CanonicalValue>): string {
  return JSON.stringify(sortKeysDeep(payload));
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

/**
 * The canonical evidence payload for one candidate document confirmation.
 * Every field is server-derived at confirmation time — never trusts the
 * client for anything except the fact that the box was checked (validated
 * separately, server-side, before this is ever built).
 */
export interface ConfirmationEvidenceInput {
  documentId: string;
  documentVersion: number | null;
  documentSha256: string;
  applicationId: string;
  identityVerificationMethod: string;
  identityVerifiedAt: string; // ISO
  consentVersion: string;
  consentTextHash: string;
  confirmedAtServer: string; // ISO
  accessSessionId: string;
  ipAddress: string | null;
  userAgent: string | null;
  receiptId: string;
}

export function buildCanonicalEvidencePayload(input: ConfirmationEvidenceInput): Record<string, CanonicalValue> {
  return {
    documentId: input.documentId,
    documentVersion: input.documentVersion,
    documentSha256: input.documentSha256,
    applicationId: input.applicationId,
    identityVerificationMethod: input.identityVerificationMethod,
    identityVerifiedAt: input.identityVerifiedAt,
    consentVersion: input.consentVersion,
    consentTextHash: input.consentTextHash,
    confirmedAtServer: input.confirmedAtServer,
    accessSessionId: input.accessSessionId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    receiptId: input.receiptId,
  };
}

/**
 * Computes EVIDENCE_SHA256 (always) and EVIDENCE_HMAC (only when a secret is
 * supplied — the HMAC secret is derived from the app's existing AUTH_SECRET
 * by the caller, never a new provisioned secret).
 */
export function computeEvidenceHashes(
  input: ConfirmationEvidenceInput,
  hmacSecret: string | null,
): { canonicalPayload: string; evidenceSha256: string; evidenceHmac: string | null } {
  const canonicalPayload = canonicalizeEvidence(buildCanonicalEvidencePayload(input));
  return {
    canonicalPayload,
    evidenceSha256: sha256Hex(canonicalPayload),
    evidenceHmac: hmacSecret ? hmacSha256Hex(canonicalPayload, hmacSecret) : null,
  };
}

/** Re-derive and compare — used by verification tooling, never trusts a stored hash blindly. */
export function verifyEvidenceHash(canonicalPayload: string, expectedSha256: string): boolean {
  return sha256Hex(canonicalPayload) === expectedSha256;
}

export function verifyEvidenceHmac(canonicalPayload: string, secret: string, expectedHmac: string): boolean {
  return hmacSha256Hex(canonicalPayload, secret) === expectedHmac;
}

/**
 * Non-predictable receipt id. The "SIG-" prefix + uppercase base32-ish
 * alphabet is display-only; entropy comes from `randomBytes`, never from
 * timestamps or sequential counters.
 */
const RECEIPT_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I ambiguity
export function generateReceiptId(bytes: Buffer = randomBytes(15)): string {
  let out = "";
  for (const byte of bytes) {
    out += RECEIPT_ALPHABET[byte % RECEIPT_ALPHABET.length];
  }
  return `SIG-${out}`;
}

/** Opaque access-session token: raw value goes to the browser ONLY; server stores just the hash. */
export function generateAccessToken(bytes: Buffer = randomBytes(32)): string {
  return bytes.toString("base64url");
}

export function hashAccessToken(rawToken: string): string {
  return sha256Hex(rawToken);
}
