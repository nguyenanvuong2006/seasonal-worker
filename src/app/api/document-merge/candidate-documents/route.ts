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
 */

import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments, dailyApplications, documentConfirmations, mergeTemplates } from "@/db/schema";

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
    })
    .from(candidateDocuments)
    .leftJoin(dailyApplications, eq(candidateDocuments.applicationId, dailyApplications.id))
    .leftJoin(mergeTemplates, eq(candidateDocuments.templateId, mergeTemplates.id))
    .orderBy(candidateDocuments.createdAt);

  const confirmations = rows.length
    ? await db
        .select()
        .from(documentConfirmations)
        .where(inArray(documentConfirmations.candidateDocumentId, rows.map((r) => r.id)))
    : [];
  const confirmedAtByDoc = new Map(confirmations.map((c) => [c.candidateDocumentId, { confirmedAtServer: c.confirmedAtServer, receiptId: c.receiptId }]));

  const summary = {
    total: rows.length,
    generating: rows.filter((r) => r.status === "GENERATING").length,
    ready: rows.filter((r) => r.status === "READY").length,
    issued: rows.filter((r) => r.status === "ISSUED").length,
    viewed: rows.filter((r) => r.status === "VIEWED").length,
    confirmed: rows.filter((r) => r.status === "CONFIRMED").length,
    failed: rows.filter((r) => r.status === "FAILED").length,
  };

  return NextResponse.json({
    summary,
    documents: rows.map((r) => ({
      ...r,
      confirmation: confirmedAtByDoc.get(r.id) ?? null,
    })),
  });
}
