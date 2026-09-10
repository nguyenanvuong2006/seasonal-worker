/**
 * GET /api/candidate-consent/documents
 *
 * STEP 2 — "HỒ SƠ CỦA BẠN". Session-cookie-gated (no CCCD/phone on this
 * request). Returns only documents whose applicationId is in the session's
 * scope, and ONLY once a staff member has explicitly released them
 * (ISSUED/VIEWED/CONFIRMED). READY is deliberately EXCLUDED — a document
 * that has finished generating and is hashed but not yet released by staff
 * must stay completely invisible to the candidate, same as
 * GENERATING/FAILED/REVOKED/SUPERSEDED/EXPIRED.
 *
 * CONFIRMATION DEADLINE + HISTORY (2026-09-10) — every row now carries its
 * own frozen `confirmationDeadlineAt` and a computed `effectiveStatus`
 * (via lifecycle.ts's effectiveStatus(), the SAME function every other read
 * path uses — never a second "is this expired" check invented here). The
 * `actionable` flag (effectiveStatus is ISSUED or VIEWED — i.e. needs the
 * candidate's attention right now) lets the UI split "CẦN XÁC NHẬN" from
 * "LỊCH SỬ" without re-deriving the rule itself. Sort is actionable-first
 * (soonest deadline first, since that is the most urgent), then everything
 * else (CONFIRMED/EXPIRED — pure history) newest-issued-first — a candidate
 * with multiple engagements always sees what needs action before old
 * records, and never loses an old CONFIRMED document from the list.
 */

import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { candidateDocuments, dailyApplications, documentConfirmations, mergeTemplates } from "@/db/schema";
import { effectiveStatus, type CandidateDocumentStatus } from "@/lib/candidate-consent/lifecycle";
import { resolveAccessSession } from "@/lib/candidate-consent/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VISIBLE_STATUSES = ["ISSUED", "VIEWED", "CONFIRMED"] as const;
const ACTIONABLE_STATUSES = new Set(["ISSUED", "VIEWED"]);

export async function GET() {
  const session = await resolveAccessSession();
  if (!session) {
    return NextResponse.json({ error: "Phiên tra cứu đã hết hạn. Vui lòng tra cứu lại." }, { status: 401 });
  }
  if (session.scopedApplicationIds.length === 0) {
    return NextResponse.json({ documents: [] });
  }

  const rows = await db
    .select({
      id: candidateDocuments.id,
      applicationId: candidateDocuments.applicationId,
      status: candidateDocuments.status,
      issuedAt: candidateDocuments.issuedAt,
      confirmationDeadlineAt: candidateDocuments.confirmationDeadlineAt,
      templateName: mergeTemplates.name,
      templateVersion: candidateDocuments.templateVersion,
      regDate: dailyApplications.regDate,
    })
    .from(candidateDocuments)
    .leftJoin(mergeTemplates, eq(candidateDocuments.templateId, mergeTemplates.id))
    .leftJoin(dailyApplications, eq(candidateDocuments.applicationId, dailyApplications.id))
    .where(inArray(candidateDocuments.applicationId, session.scopedApplicationIds));

  const visible = rows.filter((r) => (VISIBLE_STATUSES as readonly string[]).includes(r.status));
  const confirmations = visible.length
    ? await db
        .select({ candidateDocumentId: documentConfirmations.candidateDocumentId, receiptId: documentConfirmations.receiptId, confirmedAtServer: documentConfirmations.confirmedAtServer })
        .from(documentConfirmations)
        .where(inArray(documentConfirmations.candidateDocumentId, visible.map((r) => r.id)))
    : [];
  const receiptByDoc = new Map(confirmations.map((c) => [c.candidateDocumentId, c]));

  const now = new Date();
  const withEffectiveStatus = visible.map((r) => {
    const effective = effectiveStatus(r.status as CandidateDocumentStatus, r.confirmationDeadlineAt, now);
    return {
      id: r.id,
      templateName: r.templateName,
      templateVersion: r.templateVersion,
      regDate: r.regDate,
      issuedAt: r.issuedAt,
      status: r.status,
      confirmationDeadlineAt: r.confirmationDeadlineAt,
      effectiveStatus: effective,
      actionable: ACTIONABLE_STATUSES.has(effective),
      receipt: receiptByDoc.get(r.id) ?? null,
    };
  });

  // Actionable rows first (soonest deadline first — most urgent); pure
  // history rows (CONFIRMED/EXPIRED) after, newest-issued-first.
  withEffectiveStatus.sort((a, b) => {
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    if (a.actionable) {
      const aDeadline = a.confirmationDeadlineAt ? a.confirmationDeadlineAt.getTime() : Infinity;
      const bDeadline = b.confirmationDeadlineAt ? b.confirmationDeadlineAt.getTime() : Infinity;
      return aDeadline - bDeadline;
    }
    const aIssued = a.issuedAt ? a.issuedAt.getTime() : 0;
    const bIssued = b.issuedAt ? b.issuedAt.getTime() : 0;
    return bIssued - aIssued;
  });

  return NextResponse.json({ documents: withEffectiveStatus });
}
