/**
 * POST /api/candidate-consent/documents/[id]/confirm
 *
 * "Xác nhận đồng ý" — electronic consent, NOT PKI/digital signature. Server
 * independently re-validates everything (never trusts the client checkbox
 * alone): session validity + IDOR scope, document status (must be
 * ISSUED/VIEWED — never GENERATING/already-CONFIRMED/REVOKED/SUPERSEDED),
 * and the explicit `agree: true` flag in the body.
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
import { candidateDocuments, documentConfirmations } from "@/db/schema";
import { canConfirm, type CandidateDocumentStatus } from "@/lib/candidate-consent/lifecycle";
import { resolveAccessSession, sessionCanAccess } from "@/lib/candidate-consent/session-store";
import { computeEvidenceHashes, generateReceiptId, sha256Hex } from "@/lib/candidate-consent/evidence";
import { CONSENT_TEXT, CONSENT_VERSION } from "@/lib/candidate-consent/consent-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = { error: "Không tìm thấy tài liệu hoặc bạn không có quyền truy cập." };

function evidenceHmacSecret(): string | null {
  const base = process.env.AUTH_SECRET;
  return base ? `candidate-consent-evidence:v1:${base}` : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
      alreadyConfirmed: true,
    });
  }

  if (!canConfirm(doc.status as CandidateDocumentStatus) || !doc.pdfSha256) {
    return NextResponse.json(
      { error: `Không thể xác nhận hồ sơ ở trạng thái ${doc.status}.` },
      { status: 409 },
    );
  }

  const now = new Date();
  const receiptId = generateReceiptId();
  const consentTextHash = sha256Hex(CONSENT_TEXT);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const userAgent = request.headers.get("user-agent");

  const { canonicalPayload, evidenceSha256, evidenceHmac } = computeEvidenceHashes(
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
      ipAddress: ip,
      userAgent,
      receiptId,
    },
    evidenceHmacSecret(),
  );
  void canonicalPayload;

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
        ipAddress: ip,
        userAgent,
        receiptId,
        canonicalEvidenceHash: evidenceSha256,
        evidenceHmac,
      })
      .returning();

    await db
      .update(candidateDocuments)
      .set({ status: "CONFIRMED", updatedAt: now })
      .where(eq(candidateDocuments.id, id));

    return NextResponse.json({
      success: true,
      receiptId: inserted.receiptId,
      confirmedAtServer: inserted.confirmedAtServer,
      alreadyConfirmed: false,
    });
  } catch {
    // Unique-index violation from a concurrent winner — re-read and return ITS receipt.
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
        alreadyConfirmed: true,
      });
    }
    return NextResponse.json({ error: "Không thể ghi nhận xác nhận. Vui lòng thử lại." }, { status: 500 });
  }
}
