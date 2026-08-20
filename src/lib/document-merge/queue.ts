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
  isTerminalItemStatus,
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

/** Gia hạn lease cho item đang xử lý (heartbeat). */
export async function heartbeatItem(itemId: string): Promise<void> {
  await db
    .update(mergeJobRecords)
    .set({ leasedUntil: new Date(Date.now() + ITEM_LEASE_SECONDS * 1000) })
    .where(eq(mergeJobRecords.id, itemId));
}

/** Đánh dấu item COMPLETED + ghi URL/key output. */
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
): Promise<void> {
  await db
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
    .where(eq(mergeJobRecords.id, itemId));
}

/**
 * Đánh dấu item lỗi. Nếu còn lượt retry → RETRY + retry_at (backoff);
 * nếu hết lượt → FAILED. Một record lỗi KHÔNG fail toàn bộ batch.
 */
export async function failItem(
  itemId: string,
  info: { errorCode?: string | null; errorMessage?: string | null },
  opts: { attemptCount: number; maxAttempts?: number },
): Promise<ItemStatus> {
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const finalStatus: ItemStatus = shouldRetry(opts.attemptCount, max) ? ITEM_STATUS.RETRY : ITEM_STATUS.FAILED;

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
      errorCode: info.errorCode,
      errorMessage: info.errorMessage,
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

/** Reset failed-only items về RETRY (nút "Retry lỗi"). */
export async function requeueFailedItems(jobId: string): Promise<number> {
  const result = await db
    .update(mergeJobRecords)
    .set({ status: ITEM_STATUS.RETRY, retryAt: new Date(), leasedUntil: null })
    .where(and(eq(mergeJobRecords.mergeJobId, jobId), inArray(mergeJobRecords.status, [ITEM_STATUS.FAILED])))
    .returning({ id: mergeJobRecords.id });
  return result.length;
}
