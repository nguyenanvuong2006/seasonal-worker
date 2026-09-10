/**
 * GET /api/document-merge/candidate-documents
 *
 * Admin status list for "Tạo & gửi hồ sơ xác nhận" — per-candidate
 * generation/issue/view/confirm status, plus a batch summary.
 *
 * STRICTLY READ-ONLY. This route performs ZERO writes of any kind: no
 * lifecycle mutation, no Google export, no storage write, no worker
 * trigger. A GENERATING row that has actually finished generating is only
 * ever advanced to READY/FAILED by the explicit write-side
 * POST /api/document-merge/candidate-documents/finalize — never as a side
 * effect of someone polling this list (see routes-wiring.test.ts for the
 * structural proof, and finalize.ts's own docblock for why).
 *
 * CONFIRMATION DEADLINE + ENGAGEMENT (2026-09-10) — every row now also
 * exposes confirmationDeadlineAt, a derived effectiveStatus (EXPIRED
 * computed via the SAME lifecycle.ts effectiveStatus() every other read
 * path uses, never a bespoke check here), and the linked engagement's
 * "Ngày bắt đầu" (employment_sessions.starting_date) for the new admin
 * "Lần bắt đầu công việc" column — a document with no employmentSessionId
 * (legacy, pre-linkage) simply shows a null start date.
 */

import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments, dailyApplications, documentConfirmations, employmentSessions, mergeTemplates } from "@/db/schema";
import { effectiveStatus, type CandidateDocumentStatus } from "@/lib/candidate-consent/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "HR_SUPPORT", "HR_DIRECTOR"],
    "document_merge.candidate_documents.view_status",
  );
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const rows = await db
    .select({
      id: candidateDocuments.id,
      applicationId: candidateDocuments.applicationId,
      status: candidateDocuments.status,
      templateId: candidateDocuments.templateId,
      templateName: mergeTemplates.name,
      pdfSha256: candidateDocuments.pdfSha256,
      generatedAt: candidateDocuments.generatedAt,
      issuedAt: candidateDocuments.issuedAt,
      viewedAt: candidateDocuments.viewedAt,
      errorMessage: candidateDocuments.errorMessage,
      applicantFullName: dailyApplications.fullName,
      createdAt: candidateDocuments.createdAt,
      confirmationDeadlineAt: candidateDocuments.confirmationDeadlineAt,
      employmentSessionId: candidateDocuments.employmentSessionId,
      engagementStartingDate: employmentSessions.startingDate,
    })
    .from(candidateDocuments)
    .leftJoin(dailyApplications, eq(candidateDocuments.applicationId, dailyApplications.id))
    .leftJoin(mergeTemplates, eq(candidateDocuments.templateId, mergeTemplates.id))
    .leftJoin(employmentSessions, eq(candidateDocuments.employmentSessionId, employmentSessions.id))
    .orderBy(candidateDocuments.createdAt);

  const confirmations = rows.length
    ? await db
        .select()
        .from(documentConfirmations)
        .where(inArray(documentConfirmations.candidateDocumentId, rows.map((r) => r.id)))
    : [];
  const confirmedAtByDoc = new Map(confirmations.map((c) => [c.candidateDocumentId, { confirmedAtServer: c.confirmedAtServer, receiptId: c.receiptId }]));

  const now = new Date();
  const documents = rows.map((r) => ({
    ...r,
    effectiveStatus: effectiveStatus(r.status as CandidateDocumentStatus, r.confirmationDeadlineAt, now),
    confirmation: confirmedAtByDoc.get(r.id) ?? null,
  }));

  const summary = {
    total: documents.length,
    generating: documents.filter((r) => r.effectiveStatus === "GENERATING").length,
    ready: documents.filter((r) => r.effectiveStatus === "READY").length,
    issued: documents.filter((r) => r.effectiveStatus === "ISSUED").length,
    viewed: documents.filter((r) => r.effectiveStatus === "VIEWED").length,
    confirmed: documents.filter((r) => r.effectiveStatus === "CONFIRMED").length,
    failed: documents.filter((r) => r.effectiveStatus === "FAILED").length,
    expired: documents.filter((r) => r.effectiveStatus === "EXPIRED").length,
  };

  return NextResponse.json({ summary, documents });
}
