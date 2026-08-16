/**
 * Document Merge — durable async queue (Neon PostgreSQL as job state).
 *
 * Giai đoạn đầu KHÔNG cần Redis: dùng Neon làm durable queue state.
 *
 * Safe claim:
 *   SELECT … FOR UPDATE SKIP LOCKED trong 1 transaction → đảm bảo:
 *   - 2 worker KHÔNG render cùng 1 candidate;
 *   - không duplicate PDF;
 *   - không lost job (item có lease + watchdog reclaim khi worker crash).
 *
 * Retry: attempt_count + max attempts (mặc định 3) + exponential backoff.
 *
 * LƯU Ý: module này chỉ import @/db (pool) + @/db/schema + queue-types — KHÔNG
 * import server-only / auth — để Cloud Run worker (plain Node) import được.
 */

import { sql } from "drizzle-orm";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool } from "@/db";
import { mergeJobRecords, mergeJobs } from "@/db/schema";
import {
  DEFAULT_MAX_ATTEMPTS,
  ITEM_STATUS,
  isTerminalItemStatus,
  retryBackoffSeconds,
  shouldRetry,
  type ItemStatus,
} from "./queue-types.ts";

export const ITEM_LEASE_SECONDS = 60; // worker phải heartbeat trong vòng này
export const STALE_ITEM_MS = 120_000; // watchdog reclaim item treo sau 2 phút

export interface QueueItem {
  id: string;
  mergeJobId: string;
  sourceEntity: string;
  sourceRecordId: string;
  sortOrder: number;
  status: ItemStatus;
  attemptCount: number;
}

type RawItemRow = {
  id: string;
  merge_job_id: string;
  source_entity: string;
  source_record_id: string;
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
    sortOrder: row.sort_order,
    status: row.status as ItemStatus,
    attemptCount: row.attempt_count,
  };
}

/**
 * Claim tối đa `limit` items của 1 job theo đúng sequence (sort_order).
 * Chỉ claim item QUEUED/RETRY đã hết hạn lease và đã tới giờ retry.
 * Dùng FOR UPDATE SKIP LOCKED để nhiều worker chạy song song an toàn.
 */
export async function claimItems(jobId: string, limit = 1): Promise<QueueItem[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query<RawItemRow>(
      `SELECT id, merge_job_id, source_entity, source_record_id, sort_order, status, attempt_count
         FROM merge_job_records
        WHERE merge_job_id = $1
          AND status IN ('QUEUED','RETRY')
          AND (leased_until IS NULL OR leased_until < now())
          AND (retry_at IS NULL OR retry_at <= now())
        ORDER BY sort_order ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $2`,
      [jobId, limit],
    );

    const ids = result.rows.map((row) => row.id);
    if (ids.length > 0) {
      await client.query(
        `UPDATE merge_job_records
            SET status = 'PROCESSING',
                attempt_count = attempt_count + 1,
                leased_until = now() + ($2 || ' seconds')::interval,
                started_at = COALESCE(started_at, now())
          WHERE id = ANY($1::uuid[])`,
        [ids, String(ITEM_LEASE_SECONDS)],
      );
    }

    await client.query("COMMIT");
    return result.rows.map((row) => toQueueItem({ ...row, status: "PROCESSING", attempt_count: row.attempt_count + 1 }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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
  output: { pdfUrl?: string | null; storageKey?: string | null },
): Promise<void> {
  await db
    .update(mergeJobRecords)
    .set({
      status: ITEM_STATUS.COMPLETED,
      pdfUrl: output.pdfUrl ?? null,
      storageKey: output.storageKey ?? null,
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
