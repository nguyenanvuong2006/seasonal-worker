/**
 * VERIFY (AND, IF DRY_RUN=false, EXECUTE) — one real, controlled candidate
 * through the electronic-confirmation ("Hồ sơ xác nhận điện tử") pipeline,
 * up to and including READY. 2026-09 — completes the verification PR #162
 * was only partially able to prove (Google-auth worker fallback for the
 * finalize step) and confirms the individual-candidate delivery flow end to
 * end against real production data.
 *
 * WHY A SCRIPT INSTEAD OF CLICKING THE ADMIN UI: this environment has no
 * browser session and no staff login credentials — the real HTTP routes
 * (`POST candidate-documents/generate`, `POST candidate-documents/finalize`)
 * both call requirePermission() -> getSession(), which reads a cookie via
 * next/headers and only resolves inside a live Next.js request — it cannot
 * be invoked from a standalone script. This script instead calls the SAME
 * underlying, already-tested business-logic functions those routes call
 * (createAsyncMergeJob, finalizeToReady, the real storage/Google modules),
 * in the SAME order, with the SAME parameters those routes use — never
 * reimplementing their logic — so the result is faithful to what a real
 * admin click produces, not a simulation.
 *
 * WHAT THIS DOES, IN ORDER:
 *   1. Selects the single most-recently-registered ELIGIBLE candidate
 *      (deptId assigned, not REJECTED, not soft-deleted, no existing
 *      candidate_documents row yet) whose DW classification resolves to an
 *      active template — additionally htmlEnabled if the resolved engine is
 *      HTML_PDF (createAsyncMergeJob's own gate).
 *   2. DRY_RUN=true (default): prints the selection and STOPS — no writes.
 *   3. DRY_RUN=false: calls createAsyncMergeJob() (the exact function
 *      candidate-merge-job.ts's HTML_PDF branch calls) for that ONE
 *      candidate, inserts the ONE candidate_documents row exactly as
 *      generate/route.ts does, triggers the Cloud Run worker's /run (same
 *      contract callWorker()/isAuthorized() expect — Cloud Run IAM token
 *      supplied by the calling GitHub Actions workflow's own WIF identity,
 *      since this script has no Vercel OIDC token to use), polls until the
 *      item is terminal, then runs the SAME finalize logic
 *      finalize/route.ts's POST handler runs (finalizeToReady() with the
 *      PR #162 worker-fallback-aware deps) to advance GENERATING -> READY.
 *
 * NEVER issues/sends the document (no .../[id]/issue call) and NEVER
 * confirms on behalf of the candidate — this script stops at READY.
 *
 * Cách dùng:
 *   DATABASE_URL=... MERGE_WORKER_SECRET=... PDF_MERGE_WORKER_URL=... \
 *   WORKER_ID_TOKEN=... [DRY_RUN=false] \
 *     node --import tsx scripts/verify-econf-single-candidate.ts
 */
import { db, pool } from "../src/db/index.ts";
import {
  candidateDocuments,
  dailyApplications,
  mergeJobRecords,
  mergeJobs,
  mergeTemplates,
} from "../src/db/schema.ts";
import { and, desc, eq, isNotNull, isNull, ne, notInArray } from "drizzle-orm";
import { createAsyncMergeJob, AsyncJobValidationError } from "../src/lib/document-merge/async-job.ts";
import { getDocumentMergeEngine } from "../src/lib/document-merge/engine-config.ts";
import { hasDwClassificationSignal, selectTemplateForApplicant } from "../src/lib/document-merge/template-routing.ts";
import { finalizeToReady, type FinalizeDeps, type MergeJobRecordSnapshot } from "../src/lib/candidate-consent/finalize.ts";
import { exportGoogleDocAsPdf } from "../src/lib/document-merge/google-drive-pdf.ts";
import { getStorageProvider } from "../src/lib/storage/index.ts";

const DRY_RUN = (process.env.DRY_RUN ?? "true").trim().toLowerCase() !== "false";
const WORKER_URL = (process.env.PDF_MERGE_WORKER_URL ?? "").replace(/\/+$/, "");
const WORKER_SECRET = process.env.MERGE_WORKER_SECRET ?? "";
const WORKER_ID_TOKEN = process.env.WORKER_ID_TOKEN ?? "";
// Clearly-labeled automation identity — never impersonates a real staff
// member. audit_logs/merge_jobs.created_by are plain varchar (no FK to
// users), so this is safe: createdBy is simply a text label.
const SCRIPT_USERNAME = "prod-verification-script";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

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

/** Calls the Cloud Run worker directly — mirrors callWorker()'s exact header
 *  contract, but sourced from THIS workflow's own GitHub Actions WIF
 *  identity (already proven able to invoke this exact Cloud Run service by
 *  deploy-worker-production.yml's own smoke test) instead of Vercel's OIDC
 *  token, which only exists inside a real Vercel Function. */
async function callWorkerDirect<T>(path: string, body: unknown, timeoutMs = 120_000): Promise<{ ok: boolean; status: number; data: T | { error?: string } }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (WORKER_ID_TOKEN) headers["X-Serverless-Authorization"] = `Bearer ${WORKER_ID_TOKEN}`;
  if (WORKER_SECRET) {
    headers.Authorization = `Bearer ${WORKER_SECRET}`;
    headers["X-Merge-Worker-Secret"] = WORKER_SECRET;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WORKER_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function buildDeps(): FinalizeDeps {
  const storage = getStorageProvider();
  return {
    fetchGoogleDocsPdfBytes: async (record: MergeJobRecordSnapshot) => {
      if (!record.storageKey) throw new Error("GOOGLE_DOCS record missing storageKey (doc id)");
      try {
        return await exportGoogleDocAsPdf(record.storageKey);
      } catch (error) {
        if (!isMissingGoogleAuthError(error)) throw error;
        log("finalize_export_fallback_to_worker", { docId: record.storageKey.slice(0, 12) });
        const result = await callWorkerDirect<{ pdfBase64?: string; error?: string }>("/export-doc-pdf", { docId: record.storageKey });
        const data = result.data as { pdfBase64?: string; error?: string } | undefined;
        if (!result.ok || typeof data?.pdfBase64 !== "string") throw new Error(data?.error || "Không xuất được PDF qua worker.");
        return new Uint8Array(Buffer.from(data.pdfBase64, "base64"));
      }
    },
    storagePut: async (key: string, bytes: Uint8Array) => {
      try {
        const stored = await storage.put(key, Buffer.from(bytes), "application/pdf");
        return { key: stored.key, size: stored.size ?? bytes.byteLength };
      } catch (error) {
        if (!isMissingGoogleAuthError(error)) throw error;
        log("finalize_upload_fallback_to_worker", { key });
        const result = await callWorkerDirect<{ key?: string; size?: number; error?: string }>("/drive-upload-pdf", {
          key,
          pdfBase64: Buffer.from(bytes).toString("base64"),
          contentType: "application/pdf",
        });
        const data = result.data as { key?: string; size?: number; error?: string } | undefined;
        if (!result.ok || typeof data?.key !== "string") throw new Error(data?.error || "Không upload được PDF qua worker.");
        return { key: data.key, size: data.size ?? bytes.byteLength };
      }
    },
    now: () => new Date(),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  // Vercel's DOCUMENT_MERGE_ENGINE env var cannot be read from GitHub
  // Actions. Infer it from the SINGLE most recent real merge_jobs row (the
  // most direct available evidence of what a real click would resolve to
  // right now) UNLESS the caller already set DOCUMENT_MERGE_ENGINE
  // explicitly. getDocumentMergeEngine() itself is still the function that
  // makes the final decision — this only supplies its env var input.
  if (!process.env.DOCUMENT_MERGE_ENGINE) {
    const [lastJob] = await db.select({ engine: mergeJobs.engine }).from(mergeJobs).orderBy(desc(mergeJobs.createdAt)).limit(1);
    if (lastJob?.engine) {
      process.env.DOCUMENT_MERGE_ENGINE = lastJob.engine;
      log("engine_inferred_from_last_real_job", { engine: lastJob.engine });
    }
  }
  const engine = getDocumentMergeEngine();
  log("resolved_engine", { engine });

  const activeTemplates = await db.select().from(mergeTemplates).where(eq(mergeTemplates.isActive, true));

  // Candidates already tested (has a candidate_documents row) are excluded —
  // never re-select someone already used for this verification.
  const alreadyTested = await db.select({ applicationId: candidateDocuments.applicationId }).from(candidateDocuments);
  const excludeIds = alreadyTested.map((r) => r.applicationId);

  const candidates = await db
    .select()
    .from(dailyApplications)
    .where(
      and(
        isNull(dailyApplications.deletedAt),
        isNotNull(dailyApplications.deptId),
        ne(dailyApplications.status, "REJECTED"),
        excludeIds.length > 0 ? notInArray(dailyApplications.id, excludeIds) : undefined,
      ),
    )
    .orderBy(desc(dailyApplications.regDate), desc(dailyApplications.submittedAt))
    .limit(50);

  let chosen: { applicationId: string; fullName: string; template: { id: string; name: string; documentKind: string }; kind: string } | null = null;
  for (const candidate of candidates) {
    const input = { declaredType: String(candidate.declaredType ?? ""), dwMatch: String(candidate.dwMatch ?? "") };
    if (!hasDwClassificationSignal(input)) continue;
    const routed = selectTemplateForApplicant(activeTemplates, input);
    if (!routed.template) continue;
    if (engine === "HTML_PDF" && !routed.template.htmlEnabled) continue;
    chosen = {
      applicationId: candidate.id,
      fullName: candidate.fullName,
      template: { id: routed.template.id, name: routed.template.name, documentKind: routed.template.documentKind },
      kind: routed.kind,
    };
    break;
  }

  if (!chosen) {
    log("no_eligible_candidate_found", { scanned: candidates.length, engine });
    console.error("❌ Không tìm thấy ứng viên đủ điều kiện (đã xếp bộ phận, chưa REJECTED, có template active" + (engine === "HTML_PDF" ? " + htmlEnabled" : "") + ", chưa có candidate_document).");
    process.exit(1);
  }

  log("candidate_selected", {
    applicationId: chosen.applicationId,
    templateId: chosen.template.id,
    templateName: chosen.template.name,
    documentKind: chosen.template.documentKind,
    dwKind: chosen.kind,
    engine,
  });

  if (DRY_RUN) {
    log("dry_run_stop", { note: "DRY_RUN=true (default) — no writes performed. Re-run with DRY_RUN=false to execute for real." });
    await pool.end();
    return;
  }

  if (!WORKER_URL) throw new Error("Thiếu PDF_MERGE_WORKER_URL.");

  // ---- STEP 1: create the async merge job — the EXACT function
  // candidate-merge-job.ts's HTML_PDF branch calls, same params. ----
  let jobId: string;
  try {
    const result = await createAsyncMergeJob({
      templateId: chosen.template.id,
      autoRoute: false,
      mergeMode: "INDIVIDUAL_DOCUMENTS",
      dispatchToApplicant: false,
      records: { entityType: "daily_applications", recordIds: [chosen.applicationId] },
      createdBy: SCRIPT_USERNAME,
      scopeDeptIds: null,
    });
    jobId = result.jobId;
  } catch (error) {
    if (error instanceof AsyncJobValidationError) {
      log("job_creation_failed", { error: error.message, status: error.status });
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  log("merge_job_created", { jobId });

  // ---- STEP 2: insert the ONE candidate_documents row — exactly as
  // generate/route.ts does. ----
  const [record] = await db.select().from(mergeJobRecords).where(eq(mergeJobRecords.mergeJobId, jobId));
  if (!record) throw new Error("Job created but no merge_job_record was queued.");

  const [candidateDoc] = await db
    .insert(candidateDocuments)
    .values({
      applicationId: record.sourceRecordId,
      mergeJobId: jobId,
      mergeJobRecordId: record.id,
      templateId: record.templateId ?? null,
      status: "GENERATING",
    })
    .returning();
  log("candidate_document_created", { candidateDocumentId: candidateDoc.id, mergeJobRecordId: record.id });

  // ---- STEP 3: trigger the worker (same /run contract triggerPdfWorker() uses). ----
  const triggerResult = await callWorkerDirect<{ processed?: number; failed?: number }>("/run", { jobId });
  log("worker_triggered", { ok: triggerResult.ok, status: triggerResult.status, data: triggerResult.data });

  // ---- STEP 4: poll until the item is terminal (bounded ~120s). ----
  const deadline = Date.now() + 120_000;
  let finalRecord = record;
  while (Date.now() < deadline) {
    await sleep(4000);
    const [r] = await db.select().from(mergeJobRecords).where(eq(mergeJobRecords.id, record.id));
    if (!r) break;
    finalRecord = r;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(r.status)) break;
    log("polling", { status: r.status });
  }
  const [job] = await db.select().from(mergeJobs).where(eq(mergeJobs.id, jobId));
  log("merge_job_final_state", { jobId, jobStatus: job?.status, itemStatus: finalRecord.status, errorCode: finalRecord.errorCode, errorMessage: finalRecord.errorMessage });

  if (finalRecord.status !== "COMPLETED") {
    await db
      .update(candidateDocuments)
      .set({ status: "FAILED", errorMessage: finalRecord.errorMessage ?? "Sinh tài liệu thất bại.", updatedAt: new Date() })
      .where(eq(candidateDocuments.id, candidateDoc.id));
    log("stopped_before_ready", { reason: "merge item did not complete", itemStatus: finalRecord.status, errorCode: finalRecord.errorCode, errorMessage: finalRecord.errorMessage });
    console.error(`❌ Merge item không COMPLETED (status=${finalRecord.status}). Xem errorCode/errorMessage ở log trên.`);
    process.exit(1);
  }

  // ---- STEP 5: finalize GENERATING -> READY — exactly as
  // finalize/route.ts's POST handler does for this ONE document. ----
  const snapshot: MergeJobRecordSnapshot = {
    id: finalRecord.id,
    status: finalRecord.status,
    errorMessage: finalRecord.errorMessage,
    storageKey: finalRecord.storageKey,
    pdfUrl: finalRecord.pdfUrl,
    sha256: finalRecord.sha256,
    fileSize: finalRecord.fileSize,
    filename: finalRecord.filename,
    templateId: finalRecord.templateId,
  };
  const deps = buildDeps();
  let finalizeOutcome: Awaited<ReturnType<typeof finalizeToReady>>;
  try {
    finalizeOutcome = await finalizeToReady({ id: candidateDoc.id, mergeJobRecordId: record.id, applicationId: chosen.applicationId }, snapshot, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Lỗi không xác định.";
    await db.update(candidateDocuments).set({ status: "FAILED", errorMessage: message, updatedAt: new Date() }).where(eq(candidateDocuments.id, candidateDoc.id));
    log("finalize_threw", { error: message });
    console.error(`❌ Finalize lỗi: ${message}`);
    process.exit(1);
  }

  log("finalize_outcome", { outcome: finalizeOutcome.outcome });

  if (finalizeOutcome.outcome === "failed") {
    await db.update(candidateDocuments).set({ status: "FAILED", errorMessage: finalizeOutcome.errorMessage, updatedAt: new Date() }).where(eq(candidateDocuments.id, candidateDoc.id));
    console.error(`❌ Finalize outcome=failed: ${finalizeOutcome.errorMessage}`);
    process.exit(1);
  }
  if (finalizeOutcome.outcome === "unchanged") {
    console.error("❌ Finalize outcome=unchanged — item chưa ở trạng thái terminal (không nên xảy ra sau khi polling COMPLETED).");
    process.exit(1);
  }

  const [templateRow] = await db.select({ currentPublishedVersion: mergeTemplates.currentPublishedVersion }).from(mergeTemplates).where(eq(mergeTemplates.id, chosen.template.id)).limit(1);
  const readyAt = new Date(finalizeOutcome.generatedAtIso);
  await db
    .update(candidateDocuments)
    .set({
      status: "READY",
      pdfSha256: finalizeOutcome.pdfSha256,
      storageProvider: finalizeOutcome.storageProvider,
      storageKey: finalizeOutcome.storageKey,
      fileSize: finalizeOutcome.fileSize,
      filename: finalizeOutcome.filename,
      templateId: finalizeOutcome.templateId,
      templateVersion: finalizeOutcome.templateId ? (templateRow?.currentPublishedVersion ?? null) : null,
      generatedAt: readyAt,
      updatedAt: readyAt,
    })
    .where(eq(candidateDocuments.id, candidateDoc.id));

  const [finalDoc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, candidateDoc.id));

  log("READY_REACHED", {
    applicationId: chosen.applicationId,
    candidateName: chosen.fullName,
    templateId: chosen.template.id,
    templateName: chosen.template.name,
    engine,
    candidateDocumentId: candidateDoc.id,
    mergeJobId: jobId,
    mergeJobStatus: job?.status,
    pdfCreated: true,
    pdfStored: Boolean(finalDoc.storageKey),
    storageKeyPresent: Boolean(finalDoc.storageKey),
    pdfSha256Present: Boolean(finalDoc.pdfSha256),
    finalizeStatus: "READY",
    candidateDocumentStatus: finalDoc.status,
  });

  await pool.end();
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "fatal_error", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
