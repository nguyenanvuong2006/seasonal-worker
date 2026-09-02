/**
 * WRITE-SIDE FINALIZER: GENERATING -> READY (candidate_documents).
 *
 * Called ONLY from the explicit POST finalize route (never from a GET) — a
 * candidate_document must never advance its lifecycle as a side effect of
 * someone merely looking at a status list. READY means the individual PDF
 * artifact ALREADY exists, is immutable, and is hashed (pdf_sha256 +
 * storage pointer both persisted) — nothing about "issuing" it to the
 * candidate happens here; that is the separate, later READY -> ISSUED step
 * (see the finalize route, which may perform both as two distinct writes +
 * two distinct audit events in the same request, but never conflates them
 * into one state).
 *
 * A candidate_document never duplicates PDF generation: it only ever
 * consumes the ALREADY-hardened async merge pipeline's finished output
 * (worker/src/index.ts — claim/lease/CAS, unchanged by this feature). This
 * module's only two jobs are: (1) decide GENERATING -> READY/FAILED from
 * the linked merge_job_record's terminal state, and (2) for the GOOGLE_DOCS
 * engine (which does not already store bytes+sha256 the way HTML_PDF does),
 * fetch the exported PDF bytes exactly once, hash them, and store them
 * under this feature's own storage key — so the candidate is served from
 * OUR storage pointer, never a live Google Drive link the item's own
 * metadata carries.
 *
 * Dependency-injected (fetchGoogleDocsPdfBytes / storagePut) so the decision
 * logic is unit-testable without live Drive/Storage credentials.
 */

import { sha256Hex } from "./evidence.ts";

export type MergeJobRecordSnapshot = {
  id: string;
  status: string; // QUEUED | PROCESSING | COMPLETED | FAILED | RETRY | CANCELLED (+ legacy PENDING/RUNNING)
  errorMessage: string | null;
  /** HTML_PDF engine already has these — reused as-is, never re-fetched. */
  storageKey: string | null;
  pdfUrl: string | null;
  sha256: string | null;
  fileSize: number | null;
  filename: string | null;
  templateId: string | null;
};

export type CandidateDocumentGenerating = {
  id: string;
  mergeJobRecordId: string | null;
  applicationId: string;
};

export type FinalizeResult =
  | { id: string; outcome: "unchanged" }
  | { id: string; outcome: "failed"; errorMessage: string }
  | {
      id: string;
      outcome: "ready";
      pdfSha256: string;
      storageProvider: string;
      storageKey: string;
      fileSize: number;
      filename: string;
      templateId: string | null;
      generatedAtIso: string;
    };

const TERMINAL_FAILED = new Set(["FAILED", "CANCELLED"]);
const TERMINAL_COMPLETED = new Set(["COMPLETED"]);

export interface FinalizeDeps {
  /** Only called when the record has no storageKey/sha256 of its own (GOOGLE_DOCS engine path). */
  fetchGoogleDocsPdfBytes: (record: MergeJobRecordSnapshot) => Promise<Uint8Array>;
  storagePut: (key: string, bytes: Uint8Array) => Promise<{ key: string; size: number }>;
  now: () => Date;
}

function buildStorageKey(candidateDocumentId: string): string {
  return `candidate-documents/${candidateDocumentId}.pdf`;
}

/**
 * Finalize ONE candidate_document (GENERATING -> READY/unchanged/FAILED)
 * given its linked merge_job_record snapshot (or null if the link is
 * missing/broken, which is itself a FAILED state — a candidate_document
 * must never stay silently stuck).
 */
export async function finalizeToReady(
  doc: CandidateDocumentGenerating,
  record: MergeJobRecordSnapshot | null,
  deps: FinalizeDeps,
): Promise<FinalizeResult> {
  if (!record) {
    return { id: doc.id, outcome: "failed", errorMessage: "Không tìm thấy merge_job_record liên kết." };
  }
  if (TERMINAL_FAILED.has(record.status)) {
    return {
      id: doc.id,
      outcome: "failed",
      errorMessage: record.errorMessage ?? "Sinh tài liệu thất bại.",
    };
  }
  if (!TERMINAL_COMPLETED.has(record.status)) {
    return { id: doc.id, outcome: "unchanged" };
  }

  // COMPLETED. HTML_PDF engine already has storageKey + sha256 — reuse verbatim,
  // never re-render/re-hash (that would risk a different byte-for-byte result).
  if (record.storageKey && record.sha256) {
    return {
      id: doc.id,
      outcome: "ready",
      pdfSha256: record.sha256,
      storageProvider: "shared", // same provider the merge pipeline already used
      storageKey: record.storageKey,
      fileSize: record.fileSize ?? 0,
      filename: record.filename ?? `${doc.id}.pdf`,
      templateId: record.templateId,
      generatedAtIso: deps.now().toISOString(),
    };
  }

  // GOOGLE_DOCS engine: fetch bytes ONCE, hash, store under our own key so
  // the candidate is served from storage we control, not a live Drive URL.
  const bytes = await deps.fetchGoogleDocsPdfBytes(record);
  const pdfSha256 = sha256Hex(bytes);
  const stored = await deps.storagePut(buildStorageKey(doc.id), bytes);
  return {
    id: doc.id,
    outcome: "ready",
    pdfSha256,
    storageProvider: "candidate_documents_store",
    storageKey: stored.key,
    fileSize: stored.size,
    filename: record.filename ?? `${doc.id}.pdf`,
    templateId: record.templateId,
    generatedAtIso: deps.now().toISOString(),
  };
}
