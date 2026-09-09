import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePublicVerification,
  buildVerificationUrl,
  verificationMethodLabel,
  type VerificationSourceRow,
} from "./verification-service.ts";
import { buildCanonicalEvidencePayload, canonicalizeEvidence, sha256Hex, hmacSha256Hex } from "./evidence.ts";

const HMAC_SECRET = "test-only-verification-secret";

const BASE_FIELDS: Omit<VerificationSourceRow, "canonicalEvidenceHash" | "evidenceHmac"> = {
  candidateDocumentStatus: "CONFIRMED",
  documentPdfSha256: "a".repeat(64),
  documentVersion: 5,
  templateName: "Đăng ký tập nghề - Quy định tập nghề",
  applicantFullName: "nguyen van a",
  applicationId: "application-1",
  revokedAt: null,
  receiptId: "SIG-TESTRECEIPT0000001",
  confirmedAtServer: "2026-09-09T10:20:44.000Z",
  confirmationPdfSha256: "a".repeat(64),
  consentVersion: "1",
  consentTextHash: "consent-text-hash-value",
  identityVerificationMethod: "CCCD_PHONE",
  identityVerifiedAt: "2026-09-09T10:15:00.000Z",
  accessSessionId: "access-session-1",
  ipAddress: "203.0.113.7",
  userAgent: "Mozilla/5.0 (TestAgent)",
  documentId: "candidate-document-1",
  confirmationCountForDocument: 1,
};

function evidenceHashesFor(row: Omit<VerificationSourceRow, "canonicalEvidenceHash" | "evidenceHmac">, secret: string) {
  const payload = canonicalizeEvidence(
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
  return { sha256: sha256Hex(payload), hmac: hmacSha256Hex(payload, secret) };
}

/** A row whose stored evidence hashes are genuinely correct for its own fields. */
function validRow(overrides: Partial<Omit<VerificationSourceRow, "canonicalEvidenceHash" | "evidenceHmac">> = {}): VerificationSourceRow {
  const fields = { ...BASE_FIELDS, ...overrides };
  const { sha256, hmac } = evidenceHashesFor(fields, HMAC_SECRET);
  return { ...fields, canonicalEvidenceHash: sha256, evidenceHmac: hmac };
}

test("valid confirmed document => VALID, both integrity states OK/VALID", () => {
  const dto = evaluatePublicVerification(validRow(), HMAC_SECRET);
  assert.equal(dto.status, "VALID");
  assert.equal(dto.documentIntegrityState, "OK");
  assert.equal(dto.evidenceIntegrityState, "VALID");
  assert.equal(dto.candidateDisplayName, "Nguyen Van A");
  assert.equal(dto.documentVersion, 5);
  assert.equal(dto.receiptId, BASE_FIELDS.receiptId);
});

test("revoked document (evidence otherwise intact) => REVOKED, evidence still preserved", () => {
  const dto = evaluatePublicVerification(validRow({ candidateDocumentStatus: "REVOKED" }), HMAC_SECRET);
  assert.equal(dto.status, "REVOKED");
  assert.equal(dto.evidenceIntegrityState, "VALID", "revocation must never be confused with tampered evidence");
  assert.equal(dto.confirmedAtServer, BASE_FIELDS.confirmedAtServer, "the original confirmation timestamp must be preserved");
});

test("superseded document (evidence otherwise intact) => SUPERSEDED, evidence still preserved", () => {
  const dto = evaluatePublicVerification(validRow({ candidateDocumentStatus: "SUPERSEDED" }), HMAC_SECRET);
  assert.equal(dto.status, "SUPERSEDED");
  assert.equal(dto.evidenceIntegrityState, "VALID");
});

test("altered canonical evidence (a field changed after hashing) => INVALID", () => {
  const row = validRow();
  // Simulate tampering: the stored evidence hash was computed for the
  // ORIGINAL consentTextHash, but the row now carries a different one —
  // exactly what a corrupted/edited row would look like.
  const tampered: VerificationSourceRow = { ...row, consentTextHash: "a-different-consent-text-hash" };
  const dto = evaluatePublicVerification(tampered, HMAC_SECRET);
  assert.equal(dto.status, "INVALID");
  assert.equal(dto.evidenceIntegrityState, "INVALID");
});

test("altered pdf hash binding (confirmation pdf_sha256 != document pdf_sha256) => INVALID", () => {
  const row = validRow({ documentPdfSha256: "b".repeat(64) });
  const dto = evaluatePublicVerification(row, HMAC_SECRET);
  assert.equal(dto.status, "INVALID");
  assert.equal(dto.documentIntegrityState, "MISMATCH");
});

test("more than one confirmation row for the same document => INVALID (integrity anomaly, defense in depth)", () => {
  const row = validRow({ confirmationCountForDocument: 2 });
  const dto = evaluatePublicVerification(row, HMAC_SECRET);
  assert.equal(dto.status, "INVALID");
  assert.equal(dto.documentIntegrityState, "MISMATCH");
});

test("missing stored HMAC => INVALID/fail closed (never treated as valid just because sha256 matches)", () => {
  const row = { ...validRow(), evidenceHmac: null };
  const dto = evaluatePublicVerification(row, HMAC_SECRET);
  assert.equal(dto.status, "INVALID");
  assert.equal(dto.evidenceIntegrityState, "INVALID");
});

test("secret unavailable (Production DOCUMENT_EVIDENCE_SECRET missing) => INVALID/fail closed, never silently skipped", () => {
  const row = validRow();
  const dto = evaluatePublicVerification(row, null);
  assert.equal(dto.status, "INVALID");
  assert.equal(dto.evidenceIntegrityState, "INVALID");
});

test("wrong HMAC (tampered evidenceHmac column) => INVALID", () => {
  const row = { ...validRow(), evidenceHmac: "0".repeat(64) };
  const dto = evaluatePublicVerification(row, HMAC_SECRET);
  assert.equal(dto.status, "INVALID");
  assert.equal(dto.evidenceIntegrityState, "INVALID");
});

test("missing required evidence field (consentVersion empty) => INVALID, fail closed", () => {
  const row = validRow({ consentVersion: "" });
  const dto = evaluatePublicVerification(row, HMAC_SECRET);
  assert.equal(dto.status, "INVALID");
});

test("no PII, no secret, no internal id leaked into the public DTO", () => {
  const row = validRow();
  const dto = evaluatePublicVerification(row, HMAC_SECRET);
  const dtoKeys = Object.keys(dto);

  for (const forbiddenKey of [
    "ipAddress",
    "userAgent",
    "cccd",
    "phone",
    "hmac",
    "evidenceHmac",
    "canonicalEvidenceHash",
    "accessSessionId",
    "documentId",
    "applicationId",
    "storageKey",
    "storage_key",
    "sessionToken",
    "token",
  ]) {
    assert.ok(!dtoKeys.includes(forbiddenKey), `DTO must never have a "${forbiddenKey}" key`);
  }

  const serialized = JSON.stringify(dto);
  for (const secretValue of [row.ipAddress, row.userAgent, row.evidenceHmac, row.canonicalEvidenceHash, row.accessSessionId, row.documentId, row.applicationId]) {
    assert.ok(secretValue && !serialized.includes(secretValue), `serialized DTO must never contain "${secretValue}"`);
  }
  // Only a boolean presence flag for technical access evidence — never the raw values.
  assert.equal(typeof dto.technicalAccessEvidencePresent, "boolean");
  assert.equal(dto.technicalAccessEvidencePresent, true);
});

test("verificationMethodLabel never echoes the raw method code for known methods", () => {
  assert.equal(verificationMethodLabel("CCCD_PHONE"), "Xác thực qua CCCD & số điện thoại đã đăng ký");
  assert.doesNotMatch(verificationMethodLabel("CCCD_PHONE"), /CCCD_PHONE/);
});

test("buildVerificationUrl encodes only the base URL + receiptId — nothing else, ever", () => {
  assert.equal(buildVerificationUrl("https://app.example.com", "SIG-ABC123"), "https://app.example.com/xac-thuc-ho-so/SIG-ABC123");
  assert.equal(buildVerificationUrl("https://app.example.com/", "SIG-ABC123"), "https://app.example.com/xac-thuc-ho-so/SIG-ABC123");
  const url = buildVerificationUrl("https://app.example.com", "SIG-ABC123");
  assert.ok(!url.includes("?"), "must carry no query string");
  assert.ok(!url.includes("#"), "must carry no fragment");
});
