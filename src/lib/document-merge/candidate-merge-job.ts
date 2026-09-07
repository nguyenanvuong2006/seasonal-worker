/**
 * Shared "create a merge job for candidate document generation/reissue"
 * helper.
 *
 * Root cause fixed here (2026-09, HTML_PDF production engine switch):
 * candidate-documents/generate and .../[id]/reissue both called the
 * legacy /merge/execute route handler directly, in-process — a route that
 * is HARDCODED to engine: "GOOGLE_DOCS" (see its own docblock). That meant
 * the candidate electronic-confirmation workflow could NEVER produce an
 * HTML_PDF document, regardless of DOCUMENT_MERGE_ENGINE, unlike the main
 * bulk "Merge" button (merge-workspace.tsx's execute()), which already
 * branches on the SAME engine flag the rest of the app reads.
 *
 * This helper makes both candidate-document routes follow that identical,
 * single, already-established branch:
 *   - HTML_PDF: createAsyncMergeJob() directly (in-process — the same
 *     function /api/document-merge/jobs calls), then triggers the Cloud
 *     Run worker exactly like that route does. The rest of the candidate
 *     pipeline (finalizeToReady in candidate-consent/finalize.ts) already
 *     reuses an HTML_PDF item's stored storageKey+sha256 verbatim — no
 *     further change was needed there.
 *   - GOOGLE_DOCS: unchanged — delegates to the existing, already-hardened
 *     /merge/execute route handler in-process, exactly as both routes did
 *     before this change.
 *
 * This is the ONLY engine-selection branch added for this feature — it
 * reads the SAME getDocumentMergeEngine() env var every other call site
 * reads, never introduces a second mechanism.
 */
import { createAsyncMergeJob, AsyncJobValidationError } from "./async-job.ts";
import { getDocumentMergeEngine } from "./engine-config.ts";
import { triggerPdfWorker } from "./worker-trigger.ts";
import { getUserScope, type Session } from "@/lib/auth";
import { POST as executeMerge } from "@/app/api/document-merge/merge/execute/route";

export class CandidateMergeJobError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "CandidateMergeJobError";
  }
}

export async function createCandidateDocumentMergeJob(
  session: Session,
  request: Request,
  input: { templateId?: string; recordIds: string[] },
): Promise<string> {
  const engine = getDocumentMergeEngine();

  if (engine === "HTML_PDF") {
    // HTML/PDF requires one explicit, active, htmlEnabled template — same
    // gate createAsyncMergeJob() itself enforces for the main bulk merge.
    // Auto Route stays GOOGLE_DOCS-only (see async-job.ts).
    if (!input.templateId) {
      throw new CandidateMergeJobError(
        "HTML/PDF yêu cầu chọn một template cụ thể để tạo hồ sơ xác nhận — Auto Route không khả dụng cho engine này.",
        400,
      );
    }
    const scope = await getUserScope(session);
    try {
      const result = await createAsyncMergeJob({
        templateId: input.templateId,
        autoRoute: false,
        mergeMode: "INDIVIDUAL_DOCUMENTS",
        dispatchToApplicant: false,
        records: { entityType: "daily_applications", recordIds: input.recordIds },
        createdBy: session.username,
        scopeDeptIds: scope,
      });
      // HTML/PDF jobs reuse the durable merge_jobs/merge_job_records queue
      // and the existing authenticated Cloud Run trigger — same as
      // /api/document-merge/jobs.
      triggerPdfWorker(result.jobId, request);
      return result.jobId;
    } catch (error) {
      if (error instanceof AsyncJobValidationError) {
        throw new CandidateMergeJobError(error.message, error.status);
      }
      throw error;
    }
  }

  // GOOGLE_DOCS — unchanged legacy path, same in-process call both routes
  // already made before this change.
  const internalRequest = new Request("http://internal.local/api/document-merge/merge/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      templateId: input.templateId,
      mergeMode: "INDIVIDUAL_DOCUMENTS",
      batchPrint: false,
      dispatchToApplicant: false,
      autoRoute: !input.templateId,
      records: { entityType: "daily_applications", recordIds: input.recordIds },
    }),
  });
  const mergeResponse = await executeMerge(internalRequest);
  const mergeData = (await mergeResponse.json()) as { jobId?: string; error?: string };
  if (!mergeResponse.ok || !mergeData.jobId) {
    throw new CandidateMergeJobError(mergeData.error ?? "Không tạo được job sinh hồ sơ.", mergeResponse.status || 500);
  }
  return mergeData.jobId;
}
