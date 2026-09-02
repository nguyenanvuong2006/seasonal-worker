/**
 * POST /api/document-merge/candidate-documents/finalize
 *
 * THE write-side actor for GENERATING -> READY. Never triggered by a GET —
 * this is an explicit, deliberate, mutating admin action (the admin UI
 * polls THIS endpoint, not the read-only status GET, while any document is
 * still GENERATING).
 *
 * STOPS AT READY. This route NEVER issues a document to the candidate —
 * READY and ISSUED are separate business decisions made by separate actors:
 * finalization is a SYSTEM decision ("the PDF exists and is hashed"),
 * issuance is a STAFF decision ("release it to this candidate now"), made
 * explicitly via POST .../[id]/issue or its batch form. A document sitting
 * at READY is durable and stays invisible to the candidate for as long as
 * staff leaves it there.
 *
 * For each GENERATING candidate_document (optionally scoped to `ids` in the
 * body): checks its linked merge_job_record via the ALREADY-hardened async
 * merge pipeline (never re-renders/re-triggers generation itself — this
 * route only ever CONSUMES a finished item). COMPLETED -> materializes the
 * immutable PDF+SHA-256 (finalize.ts), writes candidate_documents to READY
 * (own audit event DOCUMENT_GENERATED). FAILED -> writes candidate_documents
 * to FAILED with the error, isolated per document (one candidate's failure
 * never blocks another's finalization).
 */

import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments, mergeJobRecords, mergeTemplates } from "@/db/schema";
import { exportGoogleDocAsPdf } from "@/lib/document-merge/google-drive-pdf";
import { getStorageProvider } from "@/lib/storage";
import { finalizeToReady, type FinalizeDeps, type MergeJobRecordSnapshot } from "@/lib/candidate-consent/finalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildDeps(): FinalizeDeps {
  const storage = getStorageProvider();
  return {
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
}

export async function POST(request: Request) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "HR_SUPPORT"],
    "document_merge.candidate_documents.issue",
  );
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  let body: { ids?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* ids filter is optional — empty body means "all GENERATING" */
  }
  const scopedIds = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string") : null;

  const whereClause = scopedIds
    ? inArray(candidateDocuments.id, scopedIds)
    : eq(candidateDocuments.status, "GENERATING");
  const candidates = await db
    .select({ id: candidateDocuments.id, mergeJobRecordId: candidateDocuments.mergeJobRecordId, applicationId: candidateDocuments.applicationId, status: candidateDocuments.status })
    .from(candidateDocuments)
    .where(whereClause);
  const generating = candidates.filter((c) => c.status === "GENERATING");

  if (generating.length === 0) {
    return NextResponse.json({ processed: 0, results: [] });
  }

  const recordIds = generating.map((d) => d.mergeJobRecordId).filter((v): v is string => Boolean(v));
  const records = recordIds.length
    ? await db.select().from(mergeJobRecords).where(inArray(mergeJobRecords.id, recordIds))
    : [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const deps = buildDeps();

  // Freeze which template VERSION was current at generation time — the
  // number a candidate later sees as "Phiên bản tài liệu" on their receipt.
  const templateIds = [...new Set(records.map((r) => r.templateId).filter((v): v is string => Boolean(v)))];
  const templates = templateIds.length
    ? await db.select({ id: mergeTemplates.id, currentPublishedVersion: mergeTemplates.currentPublishedVersion }).from(mergeTemplates).where(inArray(mergeTemplates.id, templateIds))
    : [];
  const templateVersionById = new Map(templates.map((t) => [t.id, t.currentPublishedVersion]));

  const results: { id: string; outcome: string }[] = [];

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

    // Isolate failures per document — one candidate's finalizer error must
    // never abort the loop for the others in the same batch.
    try {
      const result = await finalizeToReady(doc, snapshot, deps);
      results.push({ id: doc.id, outcome: result.outcome });

      if (result.outcome === "unchanged") continue;

      if (result.outcome === "failed") {
        await db
          .update(candidateDocuments)
          .set({ status: "FAILED", errorMessage: result.errorMessage, updatedAt: new Date() })
          .where(eq(candidateDocuments.id, doc.id));
        continue;
      }

      // GENERATING -> READY (own write, own audit event).
      const readyAt = new Date(result.generatedAtIso);
      await db
        .update(candidateDocuments)
        .set({
          status: "READY",
          pdfSha256: result.pdfSha256,
          storageProvider: result.storageProvider,
          storageKey: result.storageKey,
          fileSize: result.fileSize,
          filename: result.filename,
          templateId: result.templateId,
          templateVersion: result.templateId ? (templateVersionById.get(result.templateId) ?? null) : null,
          generatedAt: readyAt,
          updatedAt: readyAt,
        })
        .where(eq(candidateDocuments.id, doc.id));
      await writeAudit(guard.session, "DOCUMENT_GENERATED", "candidate_documents", {
        candidateDocumentId: doc.id,
        applicationId: doc.applicationId,
        pdfSha256: result.pdfSha256,
      });
      // STOP HERE. No auto-issue — READY is durable; a separate, explicit
      // staff action (POST .../[id]/issue or its batch form) is required
      // before the candidate can see anything.
    } catch (err) {
      results.push({ id: doc.id, outcome: "error" });
      await db
        .update(candidateDocuments)
        .set({ status: "FAILED", errorMessage: err instanceof Error ? err.message : "Lỗi không xác định.", updatedAt: new Date() })
        .where(eq(candidateDocuments.id, doc.id));
    }
  }

  return NextResponse.json({ processed: results.length, results });
}
