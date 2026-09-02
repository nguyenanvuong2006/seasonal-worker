/**
 * GET /api/candidate-consent/documents
 *
 * STEP 2 — "HỒ SƠ CỦA BẠN". Session-cookie-gated (no CCCD/phone on this
 * request). Returns only documents whose applicationId is in the session's
 * scope, and only in a VIEWABLE-or-later state (never GENERATING/FAILED —
 * nothing to show yet — and never REVOKED/SUPERSEDED/EXPIRED).
 */

import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { candidateDocuments, dailyApplications, documentConfirmations, mergeTemplates } from "@/db/schema";
import { resolveAccessSession } from "@/lib/candidate-consent/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VISIBLE_STATUSES = ["READY", "ISSUED", "VIEWED", "CONFIRMED"] as const;

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
      templateName: mergeTemplates.name,
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

  return NextResponse.json({
    documents: visible.map((r) => ({
      id: r.id,
      templateName: r.templateName,
      regDate: r.regDate,
      issuedAt: r.issuedAt,
      status: r.status,
      receipt: receiptByDoc.get(r.id) ?? null,
    })),
  });
}
