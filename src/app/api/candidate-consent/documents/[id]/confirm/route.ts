/**
 * POST /api/candidate-consent/documents/[id]/confirm
 *
 * "Xác nhận đồng ý" — electronic consent, NOT PKI/digital signature. Server
 * independently re-validates everything (never trusts the client checkbox
 * alone): session validity + IDOR scope, a FRESH re-read of the document's
 * CURRENT status (must be VIEWED — a server-proven view is a hard
 * prerequisite; never GENERATING/READY/ISSUED-but-unopened/already-
 * CONFIRMED/REVOKED/SUPERSEDED), and the explicit `agree: true` flag.
 *
 * FAILS CLOSED on the evidence secret: resolveDocumentEvidenceSecret()
 * throws in Production if DOCUMENT_EVIDENCE_SECRET is missing — this route
 * lets that propagate as a 503 BEFORE touching the DB, so a confirmation
 * can never be recorded with degraded (SHA-256-only) evidence.
 *
 * Idempotent + concurrency-safe: `document_confirmations` has a UNIQUE
 * index on candidate_document_id (migration 2026-09-01). Two simultaneous
 * confirm requests for the SAME document race to INSERT; the DB allows only
 * one to succeed, and the loser is treated as "already confirmed" (returns
 * the WINNING row's receipt, not an error) — never a duplicate evidence
 * record, never a confusing failure for a request that "lost" a race it
 * didn't need to win.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, candidateDocuments, documentConfirmations } from "@/db/schema";
import { canConfirm, type CandidateDocumentStatus } from "@/lib/candidate-consent/lifecycle";
import { resolveAccessSession, sessionCanAccess } from "@/lib/candidate-consent/session-store";
import { computeEvidenceHashes, EVIDENCE_SCHEMA_VERSION, generateReceiptId, sha256Hex } from "@/lib/candidate-consent/evidence";
import { resolveDocumentEvidenceSecret, DocumentEvidenceSecretMissingError } from "@/lib/candidate-consent/evidence-secret";
import { CONSENT_TEXT, CONSENT_VERSION } from "@/lib/candidate-consent/consent-text";
import { trustedClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = { error: "Không tìm thấy tài liệu hoặc bạn không có quyền truy cập." };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Fail closed BEFORE any DB read/write: no secret, no confirmation, ever.
  let evidenceSecret: string;
  try {
    evidenceSecret = resolveDocumentEvidenceSecret();
  } catch (err) {
    if (err instanceof DocumentEvidenceSecretMissingError) {
      return NextResponse.json({ error: "Xác nhận điện tử tạm thời không khả dụng. Vui lòng thử lại sau." }, { status: 503 });
    }
    throw err;
  }

  const session = await resolveAccessSession();
  if (!session) {
    return NextResponse.json({ error: "Phiên tra cứu đã hết hạn. Vui lòng tra cứu lại." }, { status: 401 });
  }

  let body: { agree?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  }
  if (body.agree !== true) {
    return NextResponse.json(
      { error: "Vui lòng tích chọn 'Tôi xác nhận đã đọc và đồng ý' trước khi gửi." },
      { status: 400 },
    );
  }

  const { id } = await params;
  // Fresh read of the CURRENT row — a session snapshot from login time is
  // never trusted as still-current authorization for this document's
  // lifecycle status (it may have been revoked/superseded since verifying).
  const [doc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, id)).limit(1);
  if (!doc) return NextResponse.json(NOT_FOUND, { status: 404 });
  if (!sessionCanAccess(session, doc.applicationId)) return NextResponse.json(NOT_FOUND, { status: 404 });

  // Idempotency fast path: already confirmed -> return the existing receipt, not an error.
  const [existingConfirmation] = await db
    .select()
    .from(documentConfirmations)
    .where(eq(documentConfirmations.candidateDocumentId, id))
    .limit(1);
  if (existingConfirmation) {
    return NextResponse.json({
      success: true,
      receiptId: existingConfirmation.receiptId,
      confirmedAtServer: existingConfirmation.confirmedAtServer,
      documentVersion: doc.templateVersion,
      alreadyConfirmed: true,
    });
  }

  // canConfirm requires VIEWED — a server-proven view (the pdf route's own
  // ISSUED -> VIEWED transition) is a hard prerequisite, not inferred from
  // the client. ISSUED-but-never-opened, REVOKED, SUPERSEDED, EXPIRED all
  // reject here against the FRESH status just read above.
  if (!canConfirm(doc.status as CandidateDocumentStatus) || !doc.pdfSha256) {
    return NextResponse.json(
      { error: `Không thể xác nhận hồ sơ ở trạng thái ${doc.status}.` },
      { status: 409 },
    );
  }

  const now = new Date();
  const receiptId = generateReceiptId();
  const consentTextHash = sha256Hex(CONSENT_TEXT);
  const ip = trustedClientIp(request);
  const userAgent = request.headers.get("user-agent");

  await writeAnonymousAudit("CONSENT_ACCEPTED", "candidate_documents", {
    candidateDocumentId: doc.id,
    applicationId: doc.applicationId,
    accessSessionId: session.id,
  });

  const { evidenceSha256, evidenceHmac } = computeEvidenceHashes(
    {
      documentId: doc.id,
      documentVersion: doc.templateVersion,
      documentSha256: doc.pdfSha256,
      applicationId: doc.applicationId,
      identityVerificationMethod: "CCCD_PHONE",
      identityVerifiedAt: now.toISOString(),
      consentVersion: CONSENT_VERSION,
      consentTextHash,
      confirmedAtServer: now.toISOString(),
      accessSessionId: session.id,
      ipAddress: ip === "unknown" ? null : ip,
      userAgent,
      receiptId,
    },
    evidenceSecret,
  );

  try {
    const [inserted] = await db
      .insert(documentConfirmations)
      .values({
        candidateDocumentId: doc.id,
        applicationId: doc.applicationId,
        accessSessionId: session.id,
        pdfSha256: doc.pdfSha256,
        consentVersion: CONSENT_VERSION,
        consentText: CONSENT_TEXT,
        consentTextHash,
        identityVerificationMethod: "CCCD_PHONE",
        identityVerifiedAt: now,
        confirmedAtServer: now,
        ipAddress: ip === "unknown" ? null : ip,
        userAgent,
        receiptId,
        evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
        canonicalEvidenceHash: evidenceSha256,
        evidenceHmac,
      })
      .returning();

    await db
      .update(candidateDocuments)
      .set({ status: "CONFIRMED", updatedAt: now })
      .where(eq(candidateDocuments.id, id));

    await writeAnonymousAudit("DOCUMENT_CONFIRMED", "candidate_documents", {
      candidateDocumentId: doc.id,
      applicationId: doc.applicationId,
      receiptId: inserted.receiptId,
    });

    return NextResponse.json({
      success: true,
      receiptId: inserted.receiptId,
      confirmedAtServer: inserted.confirmedAtServer,
      documentVersion: doc.templateVersion,
      alreadyConfirmed: false,
    });
  } catch {
    // Unique-index violation from a concurrent winner — re-read and return ITS receipt.
    // Retry does NOT create a duplicate CONSENT_ACCEPTED/DOCUMENT_CONFIRMED
    // audit trail beyond the CONSENT_ACCEPTED already written above (that
    // one records this request's own attempt, which is meaningful — the
    // candidate DID click confirm — even though a concurrent request won).
    const [winner] = await db
      .select()
      .from(documentConfirmations)
      .where(eq(documentConfirmations.candidateDocumentId, id))
      .limit(1);
    if (winner) {
      return NextResponse.json({
        success: true,
        receiptId: winner.receiptId,
        confirmedAtServer: winner.confirmedAtServer,
        documentVersion: doc.templateVersion,
        alreadyConfirmed: true,
      });
    }
    return NextResponse.json({ error: "Không thể ghi nhận xác nhận. Vui lòng thử lại." }, { status: 500 });
  }
}

/** Anonymous (no admin Session) audit write — same direct-insert pattern already used by /api/lookup/confirm. */
async function writeAnonymousAudit(action: string, targetType: string, details: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(auditLogs).values({ userId: null, username: "candidate", action, targetType, category: "AUDIT", details });
  } catch {
    /* audit must never break the request */
  }
}
