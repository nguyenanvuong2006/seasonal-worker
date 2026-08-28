/**
 * Document Merge — durable async queue (Neon PostgreSQL as job state).
 *
 * Giai đoạn đầu KHÔNG cần Redis: dùng Neon làm durable queue state.
 *
 * Safe claim:
 *   1 câu UPDATE...FROM (CTE SELECT ... FOR UPDATE SKIP LOCKED) duy nhất,
 *   atomic ở phía Postgres → đảm bảo:
 *   - 2 worker KHÔNG render cùng 1 candidate;
 *   - không duplicate PDF;
 *   - không lost job (item có lease + watchdog reclaim khi worker crash).
 *   Trước đây dùng client.query("BEGIN"/"COMMIT") thủ công qua `pool.connect()`
 *   riêng — multi-statement explicit transaction trên 1 connection checked-out
 *   từ pool phía app KHÔNG đảm bảo an toàn nếu DATABASE_URL trỏ vào endpoint
 *   pooled (PgBouncer transaction-pooling) của Neon: statement sau có thể bị
 *   route sang backend session khác, phá vỡ lock/visibility của FOR UPDATE
 *   ngay giữa transaction — biểu hiện đúng như quan sát thực tế: SELECT ...
 *   FOR UPDATE SKIP LOCKED không claim được 1 row QUEUED hợp lệ, lặp lại dù
 *   retry. 1 câu SQL duy nhất không có vấn đề này (đúng 1 implicit transaction,
 *   PgBouncer transaction-mode hỗ trợ hoàn toàn) — dùng `db.execute()` chung
 *   (drizzle) thay vì tự quản lý connection/transaction thủ công.
 *
 * Retry: attempt_count + max attempts (mặc định 3) + exponential backoff.
 *
 * LƯU Ý: module này chỉ import @/db + @/db/schema + queue-types — KHÔNG
 * import server-only / auth — để Cloud Run worker (plain Node) import được.
 */

import { sql } from "drizzle-orm";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { mergeJobRecords, mergeJobs } from "../../db/schema";
import {
  DEFAULT_MAX_ATTEMPTS,
  ITEM_STATUS,
  isRetryableItemError,
  isTerminalItemStatus,
  isTerminalJobStatus,
  normalizeJobStatus,
  retryBackoffSeconds,
  shouldRetry,
  type ItemStatus,
  type WorkerStage,
  type WorkerStageEvent,
} from "./queue-types.ts";

export const ITEM_LEASE_SECONDS = 60; // worker phải heartbeat trong vòng này
export const STALE_ITEM_MS = 120_000; // watchdog reclaim item treo sau 2 phút

export interface QueueItem {
  id: string;
  mergeJobId: string;
  sourceEntity: string;
  sourceRecordId: string;
  templateId: string | null;
  sortOrder: number;
  status: ItemStatus;
  attemptCount: number;
}

type RawItemRow = {
  id: string;
  merge_job_id: string;
  source_entity: string;
  source_record_id: string;
  template_id: string | null;
  sort_order: number;
  status: string;
  attempt_count: number;
};

function toQueueItem(row: RawItemRow): QueueItem {
  return {
    id: row.id,
    mergeJobId: row.merge_job_id,
    sourceEntity: row.source_entity,
    sourceRecordId: row.source_record_id,
    templateId: row.template_id,
    sortOrder: row.sort_order,
    status: row.status as ItemStatus,
    attemptCount: row.attempt_count,
  };
}

/**
 * Claim tối đa `limit` items của 1 job theo đúng sequence (sort_order).
 * Chỉ claim item QUEUED/RETRY đã hết hạn lease và đã tới giờ retry.
 * 1 câu SQL duy nhất (CTE SELECT ... FOR UPDATE SKIP LOCKED → UPDATE ...
 * FROM ... RETURNING) — atomic, không cần BEGIN/COMMIT thủ công (xem lý do
 * ở đầu file — an toàn cả khi DATABASE_URL trỏ vào endpoint pooled).
 */
export async function claimItems(jobId: string, limit = 1): Promise<QueueItem[]> {
  const result = await db.execute<RawItemRow>(sql`
    WITH claimable AS (
      SELECT id
        FROM merge_job_records
       WHERE merge_job_id = ${jobId}
         AND status IN ('QUEUED', 'RETRY')
         AND (leased_until IS NULL OR leased_until < now())
         AND (retry_at IS NULL OR retry_at <= now())
       ORDER BY sort_order ASC
       FOR UPDATE SKIP LOCKED
       LIMIT ${limit}
    )
    UPDATE merge_job_records m
       SET status = 'PROCESSING',
           attempt_count = m.attempt_count + 1,
           leased_until = now() + (${String(ITEM_LEASE_SECONDS)} || ' seconds')::interval,
           started_at = COALESCE(m.started_at, now())
      FROM claimable
     WHERE m.id = claimable.id
    RETURNING m.id, m.merge_job_id, m.source_entity, m.source_record_id, m.template_id, m.sort_order, m.status, m.attempt_count
  `);
  return (result.rows as unknown as RawItemRow[]).map(toQueueItem);
}

/**
 * Ghi lại stage worker ĐANG chạy vào merge_jobs.metadata.lastStage — để 1 job
 * kẹt PROCESSING (crash/hang/awaiting external service) luôn để lại dấu vết
 * chẩn đoán được (verification/UI đọc lại field này khi timeout), thay vì
 * chỉ biết "PROCESSING, 0%" và không rõ đang ở đâu. jsonb_set atomic — không
 * cần đọc metadata hiện tại trước (an toàn khi nhiều item chạy song song,
 * dù chỉ giữ lại stage GHI SAU CÙNG — đủ cho mục đích chẩn đoán "đang ở đâu").
 * KHÔNG BAO GIỜ throw ra ngoài — 1 lỗi ghi diagnostic không được phép làm
 * hỏng việc render PDF thật.
 */
export async function recordJobStage(
  jobId: string,
  stage: WorkerStage,
  extra: { itemId?: string | null; startedAt: number; ok: boolean; errorCode?: string | null } = { startedAt: Date.now(), ok: true },
): Promise<void> {
  const event: WorkerStageEvent = {
    stage,
    itemId: extra.itemId ?? null,
    startedAt: new Date(extra.startedAt).toISOString(),
    durationMs: Date.now() - extra.startedAt,
    ok: extra.ok,
    errorCode: extra.errorCode ?? null,
  };
  try {
    await db.execute(
      sql`UPDATE merge_jobs
             SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lastStage}', ${JSON.stringify(event)}::jsonb, true)
           WHERE id = ${jobId}`,
    );
  } catch {
    // Diagnostic write không bao giờ được phép làm fail job thật.
  }
}

/**
 * Gia hạn lease cho item đang xử lý (heartbeat).
 *
 * CRITICAL — CAS: chỉ gia hạn khi item VẪN đang PROCESSING. Nếu owner cũ bị
 * reclaim (PROCESSING → RETRY) rồi được worker khác claim lại, một heartbeat
 * muộn của owner cũ KHÔNG được kéo dài lease của lượt xử lý mới (đó là cách
 * xảy ra double-processing). Guard status ở mệnh đề WHERE đảm bảo heartbeat
 * mồ côi là no-op. Trả về số dòng được gia hạn (1 = còn sở hữu, 0 = đã mất).
 */
export async function heartbeatItem(itemId: string): Promise<number> {
  const rows = await db
    .update(mergeJobRecords)
    .set({ leasedUntil: new Date(Date.now() + ITEM_LEASE_SECONDS * 1000) })
    .where(and(eq(mergeJobRecords.id, itemId), eq(mergeJobRecords.status, ITEM_STATUS.PROCESSING)))
    .returning({ id: mergeJobRecords.id });
  return rows.length;
}

/**
 * Đánh dấu item COMPLETED + ghi URL/key output.
 *
 * CRITICAL — CAS: chỉ chuyển PROCESSING → COMPLETED. Một owner đã bị reclaim
 * (item về RETRY/QUEUED và do người khác claim) KHÔNG được ghi đè kết quả;
 * item terminal (COMPLETED/FAILED/CANCELLED) cũng không bị ghi đè. Trả về số
 * dòng thực sự commit (1 = owner hợp pháp đã commit, 0 = đã mất quyền sở hữu).
 */
export async function completeItem(
  itemId: string,
  output: {
    pdfUrl?: string | null;
    storageKey?: string | null;
    filename?: string | null;
    fileSize?: number | null;
    sha256?: string | null;
    documentHistoryId?: string | null;
  },
): Promise<number> {
  const rows = await db
    .update(mergeJobRecords)
    .set({
      status: ITEM_STATUS.COMPLETED,
      pdfUrl: output.pdfUrl ?? null,
      storageKey: output.storageKey ?? null,
      filename: output.filename ?? null,
      fileSize: output.fileSize ?? null,
      sha256: output.sha256 ?? null,
      documentHistoryId: output.documentHistoryId ?? null,
      completedAt: new Date(),
      leasedUntil: null,
      errorCode: null,
      errorMessage: null,
    })
    .where(and(eq(mergeJobRecords.id, itemId), eq(mergeJobRecords.status, ITEM_STATUS.PROCESSING)))
    .returning({ id: mergeJobRecords.id });
  return rows.length;
}

/**
 * Đánh dấu item lỗi. Lỗi deterministic (INCOMPLETE, mapping/template invalid)
 * → FAILED ngay. Lỗi hạ tầng tạm thời còn lượt retry → RETRY + retry_at.
 * Một record lỗi KHÔNG fail toàn bộ batch.
 */
export async function failItem(
  itemId: string,
  info: { errorCode?: string | null; errorMessage?: string | null },
  opts: { attemptCount: number; maxAttempts?: number; retryable?: boolean },
): Promise<ItemStatus> {
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryable = isRetryableItemError(info.errorCode, opts.retryable);
  const finalStatus: ItemStatus =
    retryable && shouldRetry(opts.attemptCount, max) ? ITEM_STATUS.RETRY : ITEM_STATUS.FAILED;

  await db
    .update(mergeJobRecords)
    .set({
      status: finalStatus,
      errorCode: info.errorCode ?? null,
      errorMessage: info.errorMessage ?? null,
      leasedUntil: null,
      retryAt: finalStatus === ITEM_STATUS.RETRY ? new Date(Date.now() + retryBackoffSeconds(opts.attemptCount) * 1000) : null,
      completedAt: finalStatus === ITEM_STATUS.FAILED ? new Date() : null,
    })
    .where(eq(mergeJobRecords.id, itemId));

  return finalStatus;
}

/**
 * Đánh dấu TẤT CẢ item chưa terminal của 1 job là FAILED trực tiếp (bỏ qua
 * retry — job-level đã fail, không còn worker nào sẽ quay lại xử lý các item
 * này). Dùng khi job phải FAILED vì lỗi job-level (vd CLAIM_STALLED,
 * RUN_JOB_CRASHED) XẢY RA TRƯỚC khi item được xử lý — nếu không, job ở trạng
 * thái terminal FAILED nhưng item vẫn "QUEUED/RETRY mãi mãi" là trạng thái mơ
 * hồ (completed=0, failed=0 — không ai biết vì sao). Trả về số item đã đánh dấu.
 */
export async function failAllNonTerminalItems(
  jobId: string,
  info: { errorCode: string; errorMessage: string },
): Promise<number> {
  const result = await db
    .update(mergeJobRecords)
    .set({
      status: ITEM_STATUS.FAILED,
      // Preserve a more specific item error already written by failItem()
      // (e.g. INCOMPLETE from DATA_RESOLUTION). Job-level CLAIM_STALLED must
      // not erase the original reason if a stall path is reached after retry.
      errorCode: sql`COALESCE(${mergeJobRecords.errorCode}, ${info.errorCode})`,
      errorMessage: sql`COALESCE(${mergeJobRecords.errorMessage}, ${info.errorMessage})`,
      leasedUntil: null,
      retryAt: null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(mergeJobRecords.mergeJobId, jobId),
        inArray(mergeJobRecords.status, [ITEM_STATUS.QUEUED, ITEM_STATUS.RETRY, ITEM_STATUS.PROCESSING]),
      ),
    )
    .returning({ id: mergeJobRecords.id });
  return result.length;
}

/**
 * Reclaim item PROCESSING bị treo (worker crash / Cloud Run restart).
 * Trả item về RETRY (giữ attempt_count) để worker khác claim lại.
 */
export async function reclaimStalledItems(jobId: string, staleBefore: Date): Promise<number> {
  const result = await db
    .update(mergeJobRecords)
    .set({
      status: ITEM_STATUS.RETRY,
      leasedUntil: null,
      retryAt: new Date(),
    })
    .where(
      and(
        eq(mergeJobRecords.mergeJobId, jobId),
        eq(mergeJobRecords.status, ITEM_STATUS.PROCESSING),
        sql`${mergeJobRecords.leasedUntil} < ${staleBefore}`,
      ),
    )
    .returning({ id: mergeJobRecords.id });
  return result.length;
}

/** Reclaim items PROCESSING bị treo trên TOÀN BỘ job (cho watchdog cron). */
export async function reclaimAllStalledItems(staleBefore: Date): Promise<number> {
  const result = await db
    .update(mergeJobRecords)
    .set({ status: ITEM_STATUS.RETRY, leasedUntil: null, retryAt: new Date() })
    .where(and(eq(mergeJobRecords.status, ITEM_STATUS.PROCESSING), sql`${mergeJobRecords.leasedUntil} < ${staleBefore}`))
    .returning({ id: mergeJobRecords.id });
  return result.length;
}

export interface JobProgress {
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  percent: number;
  terminal: boolean;
}

/** Tính lại counters + progress của 1 job từ trạng thái item, ghi vào merge_jobs. */
export async function recomputeJobProgress(jobId: string): Promise<JobProgress> {
  const [job] = await db.select().from(mergeJobs).where(eq(mergeJobs.id, jobId)).limit(1);
  if (!job) throw new Error(`merge job not found: ${jobId}`);

  const items = await db
    .select({ status: mergeJobRecords.status })
    .from(mergeJobRecords)
    .where(eq(mergeJobRecords.mergeJobId, jobId));

  let queued = 0;
  let processing = 0;
  let completed = 0;
  let failed = 0;
  for (const item of items) {
    const s = item.status as ItemStatus;
    if (s === ITEM_STATUS.COMPLETED) completed += 1;
    else if (s === ITEM_STATUS.FAILED) failed += 1;
    else if (s === ITEM_STATUS.PROCESSING) processing += 1;
    else queued += 1; // QUEUED / RETRY / PAUSED
  }

  const total = items.length;
  const finished = completed + failed;
  const percent = total === 0 ? 0 : Math.round((finished / total) * 100);
  const terminal = total > 0 && (completed + failed) === total;

  await db
    .update(mergeJobs)
    .set({
      queuedCount: queued,
      processingCount: processing,
      completedCount: completed,
      failedCount: failed,
      progressPercent: percent,
      updatedAt: new Date(),
    })
    .where(eq(mergeJobs.id, jobId));

  return { total, queued, processing, completed, failed, percent, terminal };
}

/** Chuyển job sang PROCESSING (lần claim đầu tiên). */
export async function markJobProcessing(jobId: string): Promise<void> {
  await db
    .update(mergeJobs)
    .set({ status: "PROCESSING", startedAt: sql`COALESCE(${mergeJobs.startedAt}, now())`, updatedAt: new Date() })
    .where(eq(mergeJobs.id, jobId));
}

/** Chốt job terminal (COMPLETED / FAILED / CANCELLED). */
export async function finalizeJob(
  jobId: string,
  status: "COMPLETED" | "FAILED" | "CANCELLED",
  extra: { outputPdfUrl?: string | null; outputZipUrl?: string | null; errorSummary?: string | null } = {},
): Promise<void> {
  await db
    .update(mergeJobs)
    .set({
      status,
      completedAt: new Date(),
      outputPdfUrl: extra.outputPdfUrl ?? null,
      outputZipUrl: extra.outputZipUrl ?? null,
      errorSummary: extra.errorSummary ?? null,
      updatedAt: new Date(),
    })
    .where(eq(mergeJobs.id, jobId));
}

// ---------------------------------------------------------------------------
// GOOGLE_DOCS synchronous merge — ownership + terminal CAS.
//
// The legacy engine runs the whole merge inline in one HTTP request. To make
// stale recovery safe we need (a) a liveness/lease signal refreshed during the
// long synchronous work, and (b) compare-and-set terminal writes so a request
// that has lost ownership (watchdog declared it dead, or an operator cancelled)
// can never overwrite a terminal state nor commit an output reference.
//
// We reuse existing columns (NO migration): merge_jobs.updated_at is the job
// liveness/lease timestamp; merge_job_records carries status/leased_until/
// started_at per item.
// ---------------------------------------------------------------------------

/** Liveness lease for the synchronous GOOGLE_DOCS merge (see stale-recovery). */
export const SYNC_ITEM_LEASE_SECONDS = 60;

/**
 * Refresh job+item liveness for the active synchronous merge. Cheap, safe to
 * call around every long external stage. CAS-guarded so a heartbeat from a
 * request that lost ownership is a no-op (it can not resurrect a dead/cancelled
 * job). Returns true while this request still owns the active job.
 */
export async function touchSyncMerge(jobId: string, itemIds: string[] = []): Promise<boolean> {
  const now = new Date();
  const leasedUntil = new Date(now.getTime() + SYNC_ITEM_LEASE_SECONDS * 1000);
  await db
    .update(mergeJobs)
    .set({ updatedAt: now })
    .where(and(eq(mergeJobs.id, jobId), inArray(mergeJobs.status, ["RUNNING", "PROCESSING"])));
  if (itemIds.length > 0) {
    await db
      .update(mergeJobRecords)
      .set({ leasedUntil })
      .where(and(eq(mergeJobRecords.mergeJobId, jobId), eq(mergeJobRecords.status, ITEM_STATUS.PROCESSING)));
  }
  return syncMergeOwnsJob(jobId);
}

/** True iff the synchronous merge still owns an active (non-terminal) job. */
export async function syncMergeOwnsJob(jobId: string): Promise<boolean> {
  const [job] = await db
    .select({ status: mergeJobs.status })
    .from(mergeJobs)
    .where(eq(mergeJobs.id, jobId))
    .limit(1);
  return Boolean(job) && !isTerminalJobStatus(normalizeJobStatus(job!.status));
}

/**
 * CAS job success: RUNNING/PROCESSING → COMPLETED. Returns true only if THIS
 * request performed the transition. A job already FAILED/CANCELLED (by watchdog
 * or operator) is NOT overwritten — the success path must then discard its
 * output instead of committing it.
 */
export async function casSyncJobCompleted(
  jobId: string,
  fields: { outputDocId?: string | null; outputUrl?: string | null; metadata?: Record<string, unknown> },
): Promise<boolean> {
  const rows = await db
    .update(mergeJobs)
    .set({
      status: "COMPLETED",
      outputDocId: fields.outputDocId ?? null,
      outputUrl: fields.outputUrl ?? null,
      completedAt: new Date(),
      metadata: fields.metadata ?? {},
      updatedAt: new Date(),
    })
    .where(and(eq(mergeJobs.id, jobId), inArray(mergeJobs.status, ["RUNNING", "PROCESSING"])))
    .returning({ id: mergeJobs.id });
  return rows.length === 1;
}

/**
 * CAS job failure: non-terminal → FAILED. Never overwrites COMPLETED or
 * CANCELLED. Returns true if this request performed the transition.
 */
export async function casSyncJobFailed(jobId: string, errorSummary: string, error: string): Promise<boolean> {
  const rows = await db
    .update(mergeJobs)
    .set({
      status: "FAILED",
      errorSummary: errorSummary.slice(0, 500),
      error,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(mergeJobs.id, jobId), inArray(mergeJobs.status, ["RUNNING", "PROCESSING", "QUEUED", "PENDING"])))
    .returning({ id: mergeJobs.id });
  return rows.length === 1;
}

/**
 * CAS item completion for the synchronous merge: PROCESSING → COMPLETED only.
 * Records that were failed by the watchdog (FAILED) or cancelled (CANCELLED)
 * stay terminal; the request's COMPLETED write can not resurrect them. Returns
 * the number of records actually committed.
 */
export async function casSyncItemsCompleted(jobId: string): Promise<number> {
  const rows = await db
    .update(mergeJobRecords)
    .set({ status: "COMPLETED", completedAt: new Date(), leasedUntil: null, errorCode: null, errorMessage: null })
    .where(
      and(
        eq(mergeJobRecords.mergeJobId, jobId),
        inArray(mergeJobRecords.status, [ITEM_STATUS.PROCESSING, "PENDING", "RUNNING", ITEM_STATUS.RETRY]),
      ),
    )
    .returning({ id: mergeJobRecords.id });
  return rows.length;
}

/**
 * CAS item failure for the synchronous merge: non-terminal → FAILED. Records
 * already COMPLETED (finished earlier in the same batch) or CANCELLED are left
 * untouched. Returns the number of records failed.
 */
export async function casSyncItemsFailed(jobId: string, errorCode: string, errorMessage: string): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(mergeJobRecords)
    .set({
      status: ITEM_STATUS.FAILED,
      errorCode,
      errorMessage: errorMessage.slice(0, 500),
      leasedUntil: null,
      completedAt: now,
    })
    .where(
      and(
        eq(mergeJobRecords.mergeJobId, jobId),
        inArray(mergeJobRecords.status, [ITEM_STATUS.PROCESSING, "PENDING", "RUNNING", ITEM_STATUS.RETRY, ITEM_STATUS.QUEUED]),
      ),
    )
    .returning({ id: mergeJobRecords.id });
  return rows.length;
}

/** Lấy danh sách item theo sequence — dùng khi gộp PDF tổng (đúng thứ tự user chọn). */
export async function listCompletedItemsInOrder(jobId: string): Promise<{ id: string; sortOrder: number; pdfUrl: string | null; storageKey: string | null }[]> {
  const items = await db
    .select({
      id: mergeJobRecords.id,
      sortOrder: mergeJobRecords.sortOrder,
      pdfUrl: mergeJobRecords.pdfUrl,
      storageKey: mergeJobRecords.storageKey,
    })
    .from(mergeJobRecords)
    .where(and(eq(mergeJobRecords.mergeJobId, jobId), eq(mergeJobRecords.status, ITEM_STATUS.COMPLETED)))
    .orderBy(mergeJobRecords.sortOrder);
  return items;
}

/** Job còn item chưa terminal hay không. */
export async function hasPendingItems(jobId: string): Promise<boolean> {
  const items = await db
    .select({ status: mergeJobRecords.status })
    .from(mergeJobRecords)
    .where(eq(mergeJobRecords.mergeJobId, jobId));
  return items.some((item) => !isTerminalItemStatus(item.status as ItemStatus));
}

/**
 * Còn item chưa terminal nhưng TẤT CẢ đều đang RETRY chờ backoff (retry_at > now)?
 *
 * Shared by the HTML_PDF worker and the PDF Overlay runner. A future retry_at
 * is expected after failItem() — it is NOT a claim stall. Callers must defer
 * (leave the job PROCESSING) instead of failAllNonTerminalItems(CLAIM_STALLED),
 * which would overwrite the original item error (e.g. INCOMPLETE).
 */
export async function allRemainingItemsAwaitingRetry(jobId: string): Promise<boolean> {
  const items = await db
    .select({ status: mergeJobRecords.status, retryAt: mergeJobRecords.retryAt })
    .from(mergeJobRecords)
    .where(eq(mergeJobRecords.mergeJobId, jobId));
  const pending = items.filter((item) => item.status === ITEM_STATUS.QUEUED || item.status === ITEM_STATUS.RETRY);
  if (pending.length === 0) return false;
  const now = Date.now();
  return pending.every((item) => item.retryAt !== null && item.retryAt.getTime() > now);
}

/** Reset failed-only items về RETRY (nút "Retry lỗi"). */
export async function requeueFailedItems(jobId: string): Promise<number> {
  const result = await db
    .update(mergeJobRecords)
    .set({ status: ITEM_STATUS.RETRY, retryAt: new Date(), leasedUntil: null })
    .where(and(eq(mergeJobRecords.mergeJobId, jobId), inArray(mergeJobRecords.status, [ITEM_STATUS.FAILED])))
    .returning({ id: mergeJobRecords.id });
  return result.length;
}
