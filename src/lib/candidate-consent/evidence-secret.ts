/**
 * DOCUMENT_EVIDENCE_SECRET — dedicated server secret for the electronic-
 * consent evidence HMAC. Deliberately NOT derived from AUTH_SECRET: this
 * secret protects a legally-relevant evidence record with its own,
 * independent blast radius (a session-signing key compromise must not
 * automatically compromise consent evidence, and vice versa).
 *
 * FAIL CLOSED in Production: if this secret is missing/empty, confirmation
 * must be UNAVAILABLE, never silently degrade to SHA-256-only evidence.
 * Development/test may opt into a fixed, clearly-labeled test secret so the
 * suite doesn't need real secrets to run.
 */

import "server-only";

const DEV_TEST_FALLBACK_SECRET = "dev-test-only-document-evidence-secret-do-not-use-in-production";

export class DocumentEvidenceSecretMissingError extends Error {
  constructor() {
    super(
      "DOCUMENT_EVIDENCE_SECRET is not configured. Xác nhận điện tử tạm thời không khả dụng — " +
        "vui lòng cấu hình biến môi trường DOCUMENT_EVIDENCE_SECRET trước khi bật tính năng này.",
    );
    this.name = "DocumentEvidenceSecretMissingError";
  }
}

/**
 * Resolves the evidence secret or throws (fail closed). In non-production
 * (`NODE_ENV !== "production"`) with the env var unset, returns a fixed
 * dev/test secret so local dev and `npm test` never need a real secret —
 * Production ALWAYS requires the real env var, no fallback.
 */
export function resolveDocumentEvidenceSecret(): string {
  const configured = process.env.DOCUMENT_EVIDENCE_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") return DEV_TEST_FALLBACK_SECRET;
  throw new DocumentEvidenceSecretMissingError();
}

export function isDocumentEvidenceSecretConfigured(): boolean {
  return Boolean(process.env.DOCUMENT_EVIDENCE_SECRET?.trim()) || process.env.NODE_ENV !== "production";
}
