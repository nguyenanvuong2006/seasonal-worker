/**
 * GET /api/document-merge/candidate-documents
 *
 * Admin status list for "Tạo & gửi hồ sơ xác nhận" — per-candidate
 * generation/issue/view/confirm status, plus a batch summary. Also runs the
 * lazy GENERATING -> ISSUED/FAILED promotion (see candidate-consent/promote.ts)
 * for any row still generating, so the list is always current without a
 * separate cron.
 */

import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments, dailyApplications, documentConfirmations, mergeJobRecords, mergeTemplates } from "@/db/schema";
import { exportGoogleDocAsPdf } from "@/lib/document-merge/google-drive-pdf";
import { getStorageProvider } from "@/lib/storage";
import { promoteOne, type MergeJobRecordSnapshot } from "@/lib/candidate-consent/promote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function runPromotions(generating: { id: string; mergeJobRecordId: string | null; applicationId: string }[]) {
  if (generating.length === 0) return;
  const recordIds = generating.map((d) => d.mergeJobRecordId).filter((v): v is string => Boolean(v));
  const records = recordIds.length
    ? await db.select().from(mergeJobRecords).where(inArray(mergeJobRecords.id, recordIds))
    : [];
  const byId = new Map(records.map((r) => [r.id, r]));

  const storage = getStorageProvider();
  const deps = {
    fetchGoogleDocsPdfBytes: async (record: MergeJobRecordSnapshot) => {
      if (!record.storageKey) throw new Error("GOOGLE_DOCS record missing storageKey (doc id)");
      return exportGoogleDocAsPdf(record.storageKey);
    },
    storagePut: async (key: string, bytes: Uint8Array) => {
      const stored = await storage.put(key, Buffer.from(bytes), "application/pdf");
      return { key: stored.key, size: stored.size ?? bytes.byteLength };
    },
    now: () => new Date(),
  };

  for (const doc of generating) {
    const raw = doc.mergeJobRecordId ? byId.get(doc.mergeJobRecordId) : undefined;
    const snapshot: MergeJobRecordSnapshot | null = raw
      ? {
          id: raw.id,
          status: raw.status,
          errorMessage: raw.errorMessage,
          storageKey: raw.storageKey,
          pdfUrl: raw.pdfUrl,
          sha256: raw.sha256,
          fileSize: raw.fileSize,
          filename: raw.filename,
          templateId: raw.templateId,
        }
      : null;

    const result = await promoteOne(doc, snapshot, deps);
    if (result.outcome === "unchanged") continue;
    if (result.outcome === "failed") {
      await db
        .update(candidateDocuments)
        .set({ status: "FAILED", errorMessage: result.errorMessage, updatedAt: new Date() })
        .where(eq(candidateDocuments.id, doc.id));
      continue;
    }
    await db
      .update(candidateDocuments)
      .set({
        status: "ISSUED",
        pdfSha256: result.pdfSha256,
        storageProvider: result.storageProvider,
        storageKey: result.storageKey,
        fileSize: result.fileSize,
        filename: result.filename,
        templateId: result.templateId,
        generatedAt: new Date(result.issuedAtIso),
        issuedAt: new Date(result.issuedAtIso),
        updatedAt: new Date(),
      })
      .where(eq(candidateDocuments.id, doc.id));
  }
}

export async function GET() {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "HR_SUPPORT", "HR_DIRECTOR"],
    "document_merge.candidate_documents.view_status",
  );
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const generating = await db
    .select({ id: candidateDocuments.id, mergeJobRecordId: candidateDocuments.mergeJobRecordId, applicationId: candidateDocuments.applicationId })
    .from(candidateDocuments)
    .where(eq(candidateDocuments.status, "GENERATING"));
  await runPromotions(generating);

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
