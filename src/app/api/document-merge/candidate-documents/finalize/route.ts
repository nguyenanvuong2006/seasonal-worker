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
 *
 * GOOGLE_DOCS WORKER FALLBACK (2026-09, "BATCH_PDF_GOOGLE_AUTH_FAILED: Token
 * has been expired or revoked" fix): this route runs on Vercel, a runtime
 * separate from the Cloud Run worker, whose own copy of the Google OAuth
 * credential was confirmed (via a read-only production diagnostic against
 * real candidate_documents/merge_job_records rows) to be stale, while the
 * same worker's own GOOGLE_DOCS item creation for the same job succeeds
 * (merge_job_records status COMPLETED, storageKey present). Both Google
 * calls this route makes for the GOOGLE_DOCS path -- export the doc as PDF
 * (exportGoogleDocAsPdf) and upload the bytes to Drive (storage.put) -- now
 * try the local credential first (unchanged behavior for a Vercel
 * deployment that DOES have a working local credential), and only on a
 * confirmed local-auth failure fall back to the Cloud Run worker's
 * already-authorized integration via /export-doc-pdf and /drive-upload-pdf
 * (same callWorker() channel already used by the Scan route's identical
 * fallback -- see templates/[id]/scan/route.ts). No new Google auth
 * architecture, no second OAuth connection, no credential ever returned to
 * the client -- callWorker() only sends the Authorization worker secret.
 */

import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments, mergeJobRecords, mergeTemplates } from "@/db/schema";
import { exportGoogleDocAsPdf } from "@/lib/document-merge/google-drive-pdf";
import { getStorageProvider } from "@/lib/storage";
import { finalizeToReady, type FinalizeDeps, type MergeJobRecordSnapshot } from "@/lib/candidate-consent/finalize";
import { callWorker } from "@/lib/verification/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Detects a LOCAL Google-credential failure (missing OR invalid/expired) --
 * never a genuine content/permission error (404/403/quota) the worker would
 * hit identically. Matches every Google-auth error literal this codebase's
 * independent token-exchange implementations throw (google-docs-service.ts,
 * google-drive-pdf.ts, storage/google-drive.ts).
 */
function isMissingGoogleAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  return (
    lower.includes("chưa kết nối google docs") ||
    lower.includes("missing google oauth credentials") ||
    lower.startsWith("batch_pdf_google_auth_failed") ||
    lower.startsWith("google_drive_auth_failed") ||
    lower.includes("invalid_grant") ||
    lower.includes("token has been expired or revoked")
  );
}

function buildDeps(request: Request): FinalizeDeps {
  const storage = getStorageProvider();
  return {
    fetchGoogleDocsPdfBytes: async (record: MergeJobRecordSnapshot) => {
      if (!record.storageKey) throw new Error("GOOGLE_DOCS record missing storageKey (doc id)");
      try {
        return await exportGoogleDocAsPdf(record.storageKey);
      } catch (error) {
        if (!isMissingGoogleAuthError(error)) throw error;
        const result = await callWorker<{ pdfBase64?: string; error?: string }>(
          "/export-doc-pdf",
          { docId: record.storageKey },
          60_000,
          { request },
        );
        const data = result.data as { pdfBase64?: string; error?: string } | undefined;
        if (!result.ok || typeof data?.pdfBase64 !== "string") {
          throw new Error(data?.error || "Không xuất được PDF qua worker.");
        }
        return new Uint8Array(Buffer.from(data.pdfBase64, "base64"));
      }
    },
    storagePut: async (key: string, bytes: Uint8Array) => {
      try {
        const stored = await storage.put(key, Buffer.from(bytes), "application/pdf");
        return { key: stored.key, size: stored.size ?? bytes.byteLength };
      } catch (error) {
        if (!isMissingGoogleAuthError(error)) throw error;
        const result = await callWorker<{ key?: string; size?: number; error?: string }>(
          "/drive-upload-pdf",
          { key, pdfBase64: Buffer.from(bytes).toString("base64"), contentType: "application/pdf" },
          60_000,
          { request },
        );
        const data = result.data as { key?: string; size?: number; error?: string } | undefined;
        if (!result.ok || typeof data?.key !== "string") {
          throw new Error(data?.error || "Không upload được PDF qua worker.");
        }
        return { key: data.key, size: data.size ?? bytes.byteLength };
      }
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
  const deps = buildDeps(request);

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
