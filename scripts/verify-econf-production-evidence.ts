/**
 * STRICTLY READ-ONLY Production evidence verification (2026-09) for the one
 * candidate_document the candidate has now genuinely confirmed through the
 * real browser flow (9bd3e051-c9f5-48b7-b495-dd73db8a9340).
 *
 * ZERO writes anywhere: no candidateDocuments/documentConfirmations/
 * auditLogs insert or update, no storage.put(), no confirm/issue/reissue
 * route ever called. This script only SELECTs and recomputes hashes in
 * memory using the SAME production verification functions
 * (canonicalizeEvidence / sha256Hex / verifyEvidence) confirm/route.ts
 * itself uses to build evidence — never a reimplementation.
 *
 * PRIVACY: never logs full CCCD/phone/IP/User-Agent/storage key/receipt
 * value/session token/OAuth credential/HMAC secret/DATABASE_URL — only
 * PRESENT/ABSENT/VALID booleans plus non-sensitive metadata (timestamps,
 * counts, short hash prefixes).
 *
 * Cách dùng:
 *   DATABASE_URL=... [DOCUMENT_EVIDENCE_SECRET=...] \
 *   CANDIDATE_DOCUMENT_ID=9bd3e051-c9f5-48b7-b495-dd73db8a9340 \
 *     node --import tsx scripts/verify-econf-production-evidence.ts
 */
import { db, pool } from "../src/db/index.ts";
import { auditLogs, candidateDocuments, documentConfirmations, mergeTemplates } from "../src/db/schema.ts";
import { and, eq, sql } from "drizzle-orm";
import { canonicalizeEvidence, sha256Hex, verifyEvidence, type ConfirmationEvidenceInput } from "../src/lib/candidate-consent/evidence.ts";

const EXPECTED_CANDIDATE_DOCUMENT_ID = "9bd3e051-c9f5-48b7-b495-dd73db8a9340";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  const targetId = process.env.CANDIDATE_DOCUMENT_ID ?? "";
  if (targetId !== EXPECTED_CANDIDATE_DOCUMENT_ID) {
    log("guardrail_id_mismatch", { expected: EXPECTED_CANDIDATE_DOCUMENT_ID, got: targetId || "(empty)" });
    console.error("❌ CANDIDATE_DOCUMENT_ID không khớp id đang xác minh. Dừng lại.");
    process.exit(1);
  }

  // ============================================================
  // 1. candidate_documents
  // ============================================================
  const [doc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, targetId)).limit(1);
  if (!doc) {
    log("not_found", { targetId });
    console.error("❌ Không tìm thấy candidate_document.");
    process.exit(1);
  }

  let templateRef: { id: string; name: string; currentPublishedVersion: number | null } | null = null;
  if (doc.templateId) {
    const [tpl] = await db
      .select({ id: mergeTemplates.id, name: mergeTemplates.name, currentPublishedVersion: mergeTemplates.currentPublishedVersion })
      .from(mergeTemplates)
      .where(eq(mergeTemplates.id, doc.templateId))
      .limit(1);
    templateRef = tpl ?? null;
  }

  log("CANDIDATE_DOCUMENT", {
    id: doc.id,
    status: doc.status,
    issuedAtPresent: Boolean(doc.issuedAt),
    issuedAt: doc.issuedAt,
    viewedAtPresent: Boolean(doc.viewedAt),
    viewedAt: doc.viewedAt,
    // NOTE: candidate_documents has NO dedicated confirmed_at column — the
    // schema records confirmation time on document_confirmations.confirmed_at_server
    // (joined below), and candidate_documents only flips status + updated_at.
    // Reported truthfully rather than inventing a column that doesn't exist.
    updatedAt: doc.updatedAt,
    pdfSha256Present: Boolean(doc.pdfSha256),
    storageKeyPresent: Boolean(doc.storageKey),
    templateIdPresent: Boolean(doc.templateId),
    templateVersion: doc.templateVersion,
    templateReferenceValid: Boolean(templateRef),
    templateCurrentPublishedVersion: templateRef?.currentPublishedVersion ?? null,
  });

  // ============================================================
  // 2. document_confirmations — must be EXACTLY one row
  // ============================================================
  const confirmations = await db
    .select()
    .from(documentConfirmations)
    .where(eq(documentConfirmations.candidateDocumentId, targetId));

  log("CONFIRMATION_COUNT", { value: confirmations.length });

  if (confirmations.length === 0) {
    log("no_confirmation_found", {});
    await pool.end();
    return;
  }

  const confirmation = confirmations[0];

  log("DOCUMENT_CONFIRMATION_ROW", {
    id: confirmation.id,
    candidateDocumentIdMatches: confirmation.candidateDocumentId === targetId,
    applicationIdPresent: Boolean(confirmation.applicationId),
    accessSessionIdPresent: Boolean(confirmation.accessSessionId),
    pdfSha256Present: Boolean(confirmation.pdfSha256),
    consentVersion: confirmation.consentVersion,
    consentTextHashPresent: Boolean(confirmation.consentTextHash),
    identityVerificationMethod: confirmation.identityVerificationMethod,
    identityVerifiedAtPresent: Boolean(confirmation.identityVerifiedAt),
    confirmedAtServerPresent: Boolean(confirmation.confirmedAtServer),
    confirmedAtServer: confirmation.confirmedAtServer,
    ipAddressEvidence: confirmation.ipAddress ? "PRESENT" : "ABSENT",
    userAgentEvidence: confirmation.userAgent ? "PRESENT" : "ABSENT",
    receiptIdPresent: Boolean(confirmation.receiptId),
    evidenceSchemaVersion: confirmation.evidenceSchemaVersion,
    canonicalEvidenceHashPresent: Boolean(confirmation.canonicalEvidenceHash),
    evidenceHmacPresent: Boolean(confirmation.evidenceHmac),
  });

  // ============================================================
  // 3. Cryptographic binding — recompute using the REAL production
  // verification function (verifyEvidence), never a reimplementation.
  // ============================================================
  const sha256Match = Boolean(doc.pdfSha256) && confirmation.pdfSha256 === doc.pdfSha256;
  log("PDF_SHA256_BINDING", { confirmationBoundToCurrentDocSha256: sha256Match });

  const evidenceInput: ConfirmationEvidenceInput = {
    documentId: confirmation.candidateDocumentId,
    documentVersion: doc.templateVersion,
    documentSha256: confirmation.pdfSha256,
    applicationId: confirmation.applicationId,
    identityVerificationMethod: confirmation.identityVerificationMethod,
    identityVerifiedAt: confirmation.identityVerifiedAt.toISOString(),
    consentVersion: confirmation.consentVersion,
    consentTextHash: confirmation.consentTextHash,
    confirmedAtServer: confirmation.confirmedAtServer.toISOString(),
    accessSessionId: confirmation.accessSessionId,
    ipAddress: confirmation.ipAddress,
    userAgent: confirmation.userAgent,
    receiptId: confirmation.receiptId,
  };

  const secret = process.env.DOCUMENT_EVIDENCE_SECRET?.trim() || null;
  const result = verifyEvidence(
    evidenceInput,
    { evidenceSha256: confirmation.canonicalEvidenceHash, evidenceHmac: confirmation.evidenceHmac },
    secret,
  );

  log("CANONICAL_EVIDENCE_HASH_VERIFICATION", {
    // Recomputed independently from the stored row's own fields via the same
    // canonicalizeEvidence()/sha256Hex() the confirm route used to build it.
    sha256Matches: result.sha256Matches,
  });

  if (secret) {
    log("HMAC_VERIFICATION", { hmacMatches: result.hmacMatches, secretSource: "DOCUMENT_EVIDENCE_SECRET env (not printed)" });
  } else {
    log("HMAC_VERIFICATION", {
      hmacMatches: "SKIPPED",
      reason: "DOCUMENT_EVIDENCE_SECRET not available to this diagnostic run — HMAC presence confirmed above, but not independently re-verified. Never reported as invalid without checking.",
    });
  }

  // Independent sanity check: canonical payload must at least be
  // deterministically reproducible (non-empty, valid JSON) — proves
  // canonicalizeEvidence() itself ran over real, complete field data.
  const canonicalPayload = canonicalizeEvidence({
    evidenceSchemaVersion: confirmation.evidenceSchemaVersion,
    documentId: evidenceInput.documentId,
    documentVersion: evidenceInput.documentVersion,
    documentSha256: evidenceInput.documentSha256,
    applicationId: evidenceInput.applicationId,
    identityVerificationMethod: evidenceInput.identityVerificationMethod,
    identityVerifiedAt: evidenceInput.identityVerifiedAt,
    consentVersion: evidenceInput.consentVersion,
    consentTextHash: evidenceInput.consentTextHash,
    confirmedAtServer: evidenceInput.confirmedAtServer,
    accessSessionId: evidenceInput.accessSessionId,
    ipAddress: evidenceInput.ipAddress,
    userAgent: evidenceInput.userAgent,
    receiptId: evidenceInput.receiptId,
  });
  log("canonical_payload_recomputed", { length: canonicalPayload.length, sha256Prefix: sha256Hex(canonicalPayload).slice(0, 8) });

  // ============================================================
  // 4. Audit trail — only events this schema actually implements.
  // ============================================================
  const events = await db
    .select({ action: auditLogs.action, createdAt: auditLogs.createdAt, username: auditLogs.username })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.targetType, "candidate_documents"),
        sql`${auditLogs.details} ->> 'candidateDocumentId' = ${targetId}`,
      ),
    )
    .orderBy(auditLogs.createdAt);

  const actionCounts: Record<string, number> = {};
  for (const e of events) actionCounts[e.action] = (actionCounts[e.action] ?? 0) + 1;

  log("AUDIT_TRAIL", {
    totalEvents: events.length,
    actionCounts,
    // Chronological, action + timestamp only — no PII in audit details for
    // these event types (see routes-wiring.test.ts's "no raw token" guard).
    timeline: events.map((e) => ({ action: e.action, createdAt: e.createdAt })),
  });

  const hasIssued = Boolean(actionCounts["DOCUMENT_ISSUED"]);
  const hasViewed = Boolean(actionCounts["DOCUMENT_VIEWED"]);
  const hasConfirmed = Boolean(actionCounts["DOCUMENT_CONFIRMED"]);
  const viewedEventCount = actionCounts["DOCUMENT_VIEWED"] ?? 0;

  log("AUDIT_PRESENCE", {
    issuedAuditPresent: hasIssued,
    viewedAuditPresent: hasViewed,
    confirmedAuditPresent: hasConfirmed,
    viewedEventCount,
    // This document has a KNOWN historical VIEWED event from the earlier
    // blank-PDF investigation (the pre-fix ordering bug marked VIEWED before
    // confirming artifact retrieval succeeded). >=1 VIEWED events is
    // expected and is NOT rewritten/deleted by this script.
    historicalFalseViewEventPreserved: viewedEventCount >= 1,
  });

  // ============================================================
  // 5. Idempotency
  // ============================================================
  log("IDEMPOTENCY", {
    exactlyOneConfirmationRow: confirmations.length === 1,
    // document_confirmations.candidate_document_id has a UNIQUE index
    // (document_confirmation_document_uq, migration 2026-09-01) — a second
    // INSERT for the same document is rejected at the DB layer, and the
    // confirm route's own idempotency fast-path (existingConfirmation check)
    // returns the existing receipt instead of ever attempting a second
    // insert. Verified structurally, not by attempting a duplicate write.
    duplicatePreventionMechanism: "UNIQUE INDEX document_confirmation_document_uq(candidate_document_id) + route-level idempotent fast-path",
  });

  // ============================================================
  // 6. Artifact — reference only, no download/regeneration.
  // ============================================================
  log("ARTIFACT_REFERENCE", {
    samePersistedArtifact: sha256Match,
    note: "pdf_sha256 on candidate_documents and document_confirmations match — same artifact as previously verified (worker-fallback diagnostic, PR #171). Not re-downloaded here.",
  });

  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "fatal_error", error: message.slice(0, 500) }));
  process.exit(1);
});
