/**
 * PDF Overlay — worker runner cho controlled staging E2E (PR5).
 *
 * Đây là đường render E2E riêng cho PDF Overlay, đi qua ĐÚNG cơ chế queue
 * thật (claimItems / completeItem / failItem / recomputeJobProgress /
 * finalizeJob / recordJobStage), storage thật (staging), document_history
 * thật — nhưng CHỈ nhận job có engine marker "PDF_OVERLAY" + snapshot hợp lệ
 * (xem staging-e2e.ts). Endpoint /run-overlay trong worker bị chặn 404 hoàn
 * toàn khi WORKER_ENV=production (worker-diag-gate.ts) → KHÔNG thể dùng ở
 * production, KHÔNG chạm production /run, KHÔNG merge job production.
 *
 * Khác biệt retry so với HTML runner (chủ ý, có test):
 *   - Item lỗi → failItem() → RETRY (backoff) như queue thường lệ.
 *   - Nếu sau khi xử lý xong vòng claim, toàn bộ item còn lại đang RETRY
 *     chờ backoff (retry_at > now) → worker KẾT THÚC vòng lặp mà KHÔNG fail
 *     job (job giữ PROCESSING), chờ lần /run-overlay kế tiếp claim tiếp.
 *     Như vậy retry attempt 1 → 2 → 3 (rồi FAILED) quan sát được end-to-end.
 *   - Nếu còn item QUEUED/RETRY mà KHÔNG claim được và KHÔNG đang chờ
 *     backoff (bug/visibility) → CLAIM_STALLED: fail job + fail toàn bộ item
 *     còn lại (parity với HTML runner — không để job kẹt PROCESSING mãi).
 */

import { eq, sql, type SQLWrapper } from "drizzle-orm";

import { db } from "../../../db";
import { mergeJobRecords, mergeJobs } from "../../../db/schema";
import type { StorageProvider } from "../../storage/index.ts";
import { getStorageProvider } from "../../storage/index.ts";
import {
  claimItems,
  completeItem,
  failAllNonTerminalItems,
  failItem,
  finalizeJob,
  markJobProcessing,
  recomputeJobProgress,
  recordJobStage,
  type QueueItem,
} from "../queue.ts";
import { claimRetryDelayMs, shouldRetryClaim, type WorkerStage } from "../queue-types.ts";
import { createDocumentHistory, linkRecordToHistory } from "../document-history.ts";
import { buildIndividualPdfFilename, buildIndividualStorageKey } from "../filename.ts";
import { finalizeBatchOutputs } from "../batch-finalize.ts";
import { PdfOverlayError } from "./types.ts";
import {
  OVERLAY_E2E_DOCUMENT_TYPE,
  OVERLAY_E2E_ENGINE,
  OVERLAY_E2E_RETENTION_YEARS,
  assertStagingE2EItemComplete,
  buildStagingE2EFieldValues,
  parseOverlayE2ESnapshot,
  renderStagingE2EItem,
  type OverlayE2ESnapshot,
} from "./staging-e2e.ts";
import { assertOverlayRequiredSchema, type SchemaQuerier } from "./required-schema.ts";

export interface OverlayE2ERunOptions {
  /** Storage provider — mặc định getStorageProvider() (env staging). Test inject được. */
  storage?: StorageProvider;
  /** Số item render song song — mặc định 4 (parity worker). */
  concurrency?: number;
  /** Chống loop vô hạn — mặc định 1000 (parity HTML runner). */
  maxIterations?: number;
  log?: (obj: Record<string, unknown>) => void;
  /**
   * Override schema preflight (PR5 root-cause hardening). Mặc định:
   * assertOverlayRequiredSchema qua db thật → throw SCHEMA_MISMATCH nếu thiếu
   * bảng/cột TRƯỚC overlay query. Test inject được để deterministic; production
   * (/run-overlay) KHÔNG truyền → luôn chạy preflight thật.
   */
  assertSchema?: () => Promise<void>;
}

interface OverlayE2EItemContext {
  jobId: string;
  createdBy: string;
  snapshot: OverlayE2ESnapshot;
  storage: StorageProvider;
  log: (obj: Record<string, unknown>) => void;
}

/**
 * Bọc drizzle `db.execute` thành SchemaQuerier (parity standalone verifier dùng
 * pg). Probe SQL (xem required-schema.ts) CHỈ chứa identifier từ contract — không
 * phải input người dùng — nên sql.raw an toàn (không injection).
 */
type OverlayExecutableDb = { execute: (query: string | SQLWrapper) => Promise<{ rows: unknown[] }> };

function makeDrizzleSchemaQuerier(database: OverlayExecutableDb): SchemaQuerier {
  return async (sqlText) => {
    const result = await database.execute(sql.raw(sqlText));
    return (result?.rows ?? []) as Record<string, unknown>[];
  };
}

/** Ghi stage (không bao giờ throw — parity worker HTML). */
async function stage(
  jobId: string,
  itemId: string,
  name: WorkerStage,
  startedAt: number,
  ok: boolean,
  errorCode?: string,
): Promise<void> {
  await recordJobStage(jobId, name, { itemId: itemId || null, startedAt, ok, errorCode });
}

/** Render + lưu + history + complete 1 item overlay E2E. Throw → caller failItem RENDER_FAILED. */
export async function processOverlayE2EItem(item: QueueItem, ctx: OverlayE2EItemContext): Promise<void> {
  const index = item.sortOrder;
  const total = ctx.snapshot.total;

  let t = Date.now();
  const rendered = await renderStagingE2EItem(ctx.snapshot, index, total);
  await stage(ctx.jobId, item.id, "PDF_RENDER", t, true);

  // "No unresolved placeholders": mọi placeholder có giá trị, mọi position được vẽ, 0 warning.
  const complete = assertStagingE2EItemComplete(rendered, ctx.snapshot, index, total);
  if (!complete.ok) {
    throw new Error(`OVERLAY_E2E_ITEM_INCOMPLETE: ${complete.detail}`);
  }

  const bytes = rendered.bytes;
  const sha256 = rendered.sha256;
  t = Date.now();
  await stage(ctx.jobId, item.id, "SHA256", t, true);

  const fullName = "Ung-vien-kiem-thu";
  const now = new Date();
  const filename = buildIndividualPdfFilename(now, fullName, OVERLAY_E2E_DOCUMENT_TYPE, item.sourceRecordId);
  const storageKey = buildIndividualStorageKey(now, filename);

  t = Date.now();
  const stored = await ctx.storage.put(storageKey, bytes, "application/pdf");
  await stage(ctx.jobId, item.id, "STORAGE_UPLOAD", t, true);

  // Document History — mỗi PDF = 1 record riêng (snapshot retention 3 năm, NON-PRODUCTION).
  t = Date.now();
  const history = await createDocumentHistory({
    candidateId: null,
    applicationId: item.sourceRecordId,
    mergeJobId: item.mergeJobId,
    mergeJobRecordId: item.id,
    templateId: null,
    templateVersion: null,
    documentType: OVERLAY_E2E_DOCUMENT_TYPE,
    filename,
    storageProvider: ctx.storage.name,
    storageFileId: stored.key,
    fileSize: bytes.byteLength,
    sha256,
    retentionYears: OVERLAY_E2E_RETENTION_YEARS,
    createdBy: ctx.createdBy,
  });
  await linkRecordToHistory(item.id, history.id);
  await stage(ctx.jobId, item.id, "HISTORY_WRITE", t, true);

  t = Date.now();
  await completeItem(item.id, {
    pdfUrl: stored.url,
    storageKey,
    filename,
    fileSize: bytes.byteLength,
    sha256,
    documentHistoryId: history.id,
  });
  await stage(ctx.jobId, item.id, "ITEM_COMPLETE", t, true);
}

/** Còn item chưa terminal nhưng TẤT CẢ đều đang RETRY chờ backoff (retry_at > now)? */
export async function allRemainingItemsAwaitingRetry(jobId: string): Promise<boolean> {
  const items = await db
    .select({ status: mergeJobRecords.status, retryAt: mergeJobRecords.retryAt })
    .from(mergeJobRecords)
    .where(eq(mergeJobRecords.mergeJobId, jobId));
  const pending = items.filter((i) => i.status === "QUEUED" || i.status === "RETRY");
  if (pending.length === 0) return false;
  const now = Date.now();
  return pending.every((i) => i.retryAt !== null && i.retryAt.getTime() > now);
}

/**
 * Chạy 1 job overlay E2E tới terminal (hoặc defer khi item đang chờ retry
 * backoff). Trả {processed, failed}. Ném lỗi nếu job không tồn tại / không
 * phải overlay E2E / crash job-level (caller /run-overlay trả HTTP 500).
 */
export async function runOverlayE2EJob(
  jobId: string,
  options: OverlayE2ERunOptions = {},
): Promise<{ processed: number; failed: number }> {
  // PR5 root-cause hardening: deterministic schema preflight TRƯỚC overlay query.
  // Phát hiện thiếu/không tương thích bảng-cột (SCHEMA_MISMATCH) ngay lập tức thay
  // vì để query thật nổ lỗi mờ ở giữa vòng claim/render. Mặc định probe qua db
  // thật; test inject được qua options.assertSchema để deterministic.
  const assertSchema = options.assertSchema ?? (() => assertOverlayRequiredSchema(makeDrizzleSchemaQuerier(db)));
  await assertSchema();

  const log = options.log ?? ((obj: Record<string, unknown>) => console.log(JSON.stringify(obj)));
  const storage = options.storage ?? getStorageProvider();
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const maxIterations = options.maxIterations ?? 1000;

  const [job] = await db.select().from(mergeJobs).where(eq(mergeJobs.id, jobId)).limit(1);
  if (!job) throw new Error("job not found");
  if (job.engine !== OVERLAY_E2E_ENGINE) {
    throw new Error(`OVERLAY_E2E_ENGINE_MISMATCH: engine=${String(job.engine)} != ${OVERLAY_E2E_ENGINE}`);
  }
  let snapshot: OverlayE2ESnapshot;
  try {
    snapshot = parseOverlayE2ESnapshot(job.metadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OVERLAY_E2E_SNAPSHOT_INVALID: ${message}`);
  }

  const jobCtx: OverlayE2EItemContext = { jobId, createdBy: job.createdBy, snapshot, storage, log };
  const jobStartedAt = Date.now();
  await markJobProcessing(jobId);
  await stage(jobId, "", "JOB_CLAIMED", jobStartedAt, true);

  let processed = 0;
  let failed = 0;

  try {
    for (let iter = 0; iter < maxIterations; iter++) {
      let items = await claimItems(jobId, concurrency);

      if (items.length === 0) {
        const check = await recomputeJobProgress(jobId);
        if (check.queued === 0) break;

        let attempt = 1;
        while (items.length === 0 && shouldRetryClaim(attempt)) {
          await new Promise((r) => setTimeout(r, claimRetryDelayMs(attempt)));
          items = await claimItems(jobId, concurrency);
          attempt += 1;
        }

        if (items.length === 0) {
          // Retry semantics (khác HTML runner — chủ ý, xem header file):
          // item đang RETRY chờ backoff → kết thúc vòng, job giữ PROCESSING,
          // lần /run-overlay kế tiếp sẽ claim. KHÔNG fail job.
          if (await allRemainingItemsAwaitingRetry(jobId)) break;

          const errorMessage = `CLAIM_STALLED: còn ${check.queued} item QUEUED/RETRY nhưng claimItems() không claim được sau ${attempt} lần thử.`;
          await stage(jobId, "", "JOB_CLAIMED", Date.now(), false, "CLAIM_STALLED");
          const failedItemCount = await failAllNonTerminalItems(jobId, { errorCode: "CLAIM_STALLED", errorMessage });
          await recomputeJobProgress(jobId);
          await finalizeJob(jobId, "FAILED", { errorSummary: errorMessage });
          log({ event: "pdf_overlay_e2e_claim_stalled", jobId, queuedRemaining: check.queued, attempts: attempt, itemsMarkedFailed: failedItemCount });
          return { processed, failed: failed + failedItemCount };
        }
      }

      await Promise.all(
        items.map(async (item) => {
          try {
            await processOverlayE2EItem(item, jobCtx);
            processed += 1;
          } catch (error) {
            failed += 1;
            const message = error instanceof Error ? error.message : String(error);
            const code = error instanceof PdfOverlayError ? error.code : "RENDER_FAILED";
            await failItem(
              item.id,
              { errorCode: "RENDER_FAILED", errorMessage: `${code}: ${message}`.slice(0, 500) },
              { attemptCount: item.attemptCount },
            );
            log({ event: "pdf_overlay_e2e_item_failed", jobId, sequence: item.sortOrder, error: `${code}: ${message}`.slice(0, 200) });
          }
        }),
      );

      await recomputeJobProgress(jobId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorSummary = `RUN_JOB_CRASHED: ${message.slice(0, 500)}`;
    await failAllNonTerminalItems(jobId, { errorCode: "RUN_JOB_CRASHED", errorMessage: errorSummary }).catch(() => undefined);
    await recomputeJobProgress(jobId).catch(() => undefined);
    await finalizeJob(jobId, "FAILED", { errorSummary }).catch(() => undefined);
    log({ event: "pdf_overlay_e2e_run_crashed", jobId, error: message.slice(0, 300) });
    throw error;
  }

  const progress = await recomputeJobProgress(jobId);

  // Hết pending items → batch PDF tổng + ZIP (ephemeral, parity HTML runner).
  if (progress.terminal) {
    if (progress.completed > 0) {
      const finalizeStartedAt = Date.now();
      try {
        const finalize = await finalizeBatchOutputs(jobId, { documentType: OVERLAY_E2E_DOCUMENT_TYPE, storage });
        await finalizeJob(jobId, "COMPLETED", {
          outputPdfUrl: finalize.pdfUrl,
          outputZipUrl: finalize.zipUrl,
          errorSummary: progress.failed > 0 ? `${progress.failed} item FAILED (đã retry tối đa)` : null,
        });
        await stage(jobId, "", "BATCH_FINALIZE", finalizeStartedAt, true);
        log({
          event: "pdf_overlay_e2e_batch_finalized",
          jobId,
          itemCount: finalize.itemCount,
          pdfBytes: finalize.pdfBytes,
          zipBytes: finalize.zipBytes,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finalizeJob(jobId, "FAILED", { errorSummary: `FINALIZE_FAILED: ${message.slice(0, 500)}` });
        await stage(jobId, "", "BATCH_FINALIZE", finalizeStartedAt, false, "FINALIZE_FAILED");
        log({ event: "pdf_overlay_e2e_batch_finalize_failed", jobId, error: message.slice(0, 300) });
      }
    } else {
      await finalizeJob(jobId, progress.failed > 0 ? "FAILED" : "COMPLETED", {
        errorSummary: progress.failed > 0 ? "Toàn bộ item FAILED." : null,
      });
    }
  }

  log({
    event: "pdf_overlay_e2e_run",
    jobId,
    processed,
    failed,
    durationMs: Date.now() - jobStartedAt,
    concurrency,
    terminal: progress.terminal,
    finalizeStatus: progress.terminal && progress.completed > 0 ? "attempted" : "skipped",
  });
  return { processed, failed };
}
