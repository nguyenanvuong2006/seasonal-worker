/**
 * GET /api/xac-thuc-ho-so/[token]
 *
 * PUBLIC, unauthenticated, read-only third-party verification endpoint.
 * `token` is `document_confirmations.receipt_id` — an opaque, unique,
 * non-sequential, non-PII identifier already minted by the confirm route
 * (see verification-service.ts's own docblock for why no new column/
 * migration was needed for this).
 *
 * READ-ONLY with respect to candidate_documents/document_confirmations:
 * this route NEVER inserts/updates/deletes evidence, never mutates a
 * document's lifecycle status, never writes to audit_logs. The ONLY write
 * this route performs is the rate-limit bookkeeping row in the existing
 * identity_lookup_attempts table (namespaced "verify-ip:" — see
 * identity.ts's verifyIpLimiterKey — so it can never share state with the
 * CCCD+phone lookup endpoint's own buckets), reusing the exact same
 * durable, Postgres-backed, fail-closed limiter already proven by
 * /api/candidate-consent/lookup.
 *
 * Generic 404 for both "no such receipt" and any structurally-unreachable
 * read — a caller probing random tokens gets the same response either way,
 * and is rate-limited regardless of whether the token exists.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { candidateDocuments, dailyApplications, documentConfirmations, identityLookupAttempts, mergeTemplates } from "@/db/schema";
import { evaluatePublicVerification, type VerificationSourceRow } from "@/lib/candidate-consent/verification-service";
import { resolveDocumentEvidenceSecret, DocumentEvidenceSecretMissingError } from "@/lib/candidate-consent/evidence-secret";
import { evaluateAttempt, resetOnSuccess, type LimiterRow } from "@/lib/candidate-consent/rate-limiter";
import { verifyIpLimiterKey } from "@/lib/candidate-consent/identity";
import { trustedClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = { status: "NOT_FOUND" as const };
const RATE_LIMIT_UNAVAILABLE = { error: "Hệ thống đang bận. Vui lòng thử lại sau ít phút." };

function verifySecret(): string {
  const base = process.env.AUTH_SECRET;
  if (!base) throw new Error("AUTH_SECRET is not configured");
  return `candidate-consent-verify:v1:${base}`;
}

async function readLimiterRow(key: string): Promise<LimiterRow | null> {
  const [row] = await db.select().from(identityLookupAttempts).where(eq(identityLookupAttempts.limiterKey, key)).limit(1);
  if (!row) return null;
  return {
    attemptCount: row.attemptCount,
    windowStartMs: row.windowStartAt.getTime(),
    lockedUntilMs: row.lockedUntil ? row.lockedUntil.getTime() : null,
    lockoutStrikes: row.lockoutStrikes,
  };
}

async function writeLimiterRow(key: string, next: LimiterRow): Promise<void> {
  await db
    .insert(identityLookupAttempts)
    .values({
      limiterKey: key,
      attemptCount: next.attemptCount,
      windowStartAt: new Date(next.windowStartMs),
      lockedUntil: next.lockedUntilMs ? new Date(next.lockedUntilMs) : null,
      lockoutStrikes: next.lockoutStrikes,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: identityLookupAttempts.limiterKey,
      set: {
        attemptCount: next.attemptCount,
        windowStartAt: new Date(next.windowStartMs),
        lockedUntil: next.lockedUntilMs ? new Date(next.lockedUntilMs) : null,
        lockoutStrikes: next.lockoutStrikes,
        updatedAt: new Date(),
      },
    });
}

/**
 * Full name display only — same source (daily_applications.full_name) the
 * candidate's own document list already reads via a plain leftJoin
 * elsewhere; done as a targeted lookup here since the applicationId comes
 * from the confirmation row, not from an already-joined query.
 */
async function lookupApplicantFullName(applicationId: string): Promise<string | null> {
  const [row] = await db.select({ fullName: dailyApplications.fullName }).from(dailyApplications).where(eq(dailyApplications.id, applicationId)).limit(1);
  return row?.fullName ?? null;
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const receiptId = decodeURIComponent(token || "").trim();
  if (!receiptId) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  // Fail closed: rate-limit store unavailable -> deny, never unlimited.
  const ip = trustedClientIp(request);
  const now = Date.now();
  let decision: ReturnType<typeof evaluateAttempt>;
  let limiterKey: string;
  try {
    const secret = verifySecret();
    limiterKey = verifyIpLimiterKey(ip, secret);
    const row = await readLimiterRow(limiterKey);
    decision = evaluateAttempt(row, now);
    await writeLimiterRow(limiterKey, decision.nextRow);
  } catch (err) {
    console.error("[xac-thuc-ho-so] rate-limit store unavailable, denying:", err);
    return NextResponse.json(RATE_LIMIT_UNAVAILABLE, { status: 503 });
  }
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Bạn đã kiểm tra quá nhiều lần. Vui lòng thử lại sau." },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
    );
  }

  const [confirmation] = await db
    .select()
    .from(documentConfirmations)
    .where(eq(documentConfirmations.receiptId, receiptId))
    .limit(1);
  if (!confirmation) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  const [doc] = await db
    .select({
      status: candidateDocuments.status,
      pdfSha256: candidateDocuments.pdfSha256,
      templateVersion: candidateDocuments.templateVersion,
      revokedAt: candidateDocuments.revokedAt,
      templateName: mergeTemplates.name,
    })
    .from(candidateDocuments)
    .leftJoin(mergeTemplates, eq(candidateDocuments.templateId, mergeTemplates.id))
    .where(eq(candidateDocuments.id, confirmation.candidateDocumentId))
    .limit(1);
  if (!doc) {
    // Structurally unreachable (FK), but never assume — generic NOT_FOUND.
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  const applicant = await lookupApplicantFullName(confirmation.applicationId);

  const allConfirmationsForDoc = await db
    .select({ id: documentConfirmations.id })
    .from(documentConfirmations)
    .where(eq(documentConfirmations.candidateDocumentId, confirmation.candidateDocumentId));

  let hmacSecret: string | null;
  try {
    hmacSecret = resolveDocumentEvidenceSecret();
  } catch (err) {
    if (err instanceof DocumentEvidenceSecretMissingError) {
      hmacSecret = null; // fail closed inside evaluatePublicVerification — never throws the request itself
    } else {
      throw err;
    }
  }

  const row: VerificationSourceRow = {
    candidateDocumentStatus: doc.status,
    documentPdfSha256: doc.pdfSha256,
    documentVersion: doc.templateVersion,
    templateName: doc.templateName,
    applicantFullName: applicant,
    applicationId: confirmation.applicationId,
    revokedAt: doc.revokedAt ? doc.revokedAt.toISOString() : null,
    receiptId: confirmation.receiptId,
    confirmedAtServer: confirmation.confirmedAtServer.toISOString(),
    confirmationPdfSha256: confirmation.pdfSha256,
    consentVersion: confirmation.consentVersion,
    consentTextHash: confirmation.consentTextHash,
    identityVerificationMethod: confirmation.identityVerificationMethod,
    identityVerifiedAt: confirmation.identityVerifiedAt.toISOString(),
    accessSessionId: confirmation.accessSessionId,
    ipAddress: confirmation.ipAddress,
    userAgent: confirmation.userAgent,
    canonicalEvidenceHash: confirmation.canonicalEvidenceHash,
    evidenceHmac: confirmation.evidenceHmac,
    documentId: confirmation.candidateDocumentId,
    confirmationCountForDocument: allConfirmationsForDoc.length,
  };

  const dto = evaluatePublicVerification(row, hmacSecret);

  // Successful, well-formed lookups reset this IP's bucket — legitimate
  // repeat checks (a candidate re-scanning their own QR, a third party
  // re-opening the link) must never accumulate toward a lockout.
  try {
    await writeLimiterRow(limiterKey, resetOnSuccess(now));
  } catch {
    /* non-fatal */
  }

  return NextResponse.json(dto);
}
