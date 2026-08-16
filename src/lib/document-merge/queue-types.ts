/**
 * Document Merge — async queue status vocabulary + pure helpers.
 *
 * Trạng thái ITEM (merge_job_records.status):
 *   QUEUED | PROCESSING | COMPLETED | FAILED | RETRY | PAUSED | CANCELLED
 * Legacy code dùng PENDING/RUNNING — được normalize tương đương:
 *   PENDING → QUEUED, RUNNING → PROCESSING
 *
 * Trạng thái JOB (merge_jobs.status):
 *   QUEUED | PROCESSING | PAUSED | COMPLETED | FAILED | CANCELLED
 */

export const ITEM_STATUS = {
  QUEUED: "QUEUED",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  RETRY: "RETRY",
  PAUSED: "PAUSED",
  CANCELLED: "CANCELLED",
} as const;

export type ItemStatus = (typeof ITEM_STATUS)[keyof typeof ITEM_STATUS];

export const JOB_STATUS = {
  QUEUED: "QUEUED",
  PROCESSING: "PROCESSING",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/** Legacy → canonical status normalization (history UI / old rows vẫn đọc đúng). */
export function normalizeItemStatus(raw: string | null | undefined): ItemStatus {
  switch ((raw ?? "").trim().toUpperCase()) {
    case "PENDING":
    case "QUEUED":
      return ITEM_STATUS.QUEUED;
    case "RUNNING":
    case "PROCESSING":
      return ITEM_STATUS.PROCESSING;
    case "COMPLETED":
      return ITEM_STATUS.COMPLETED;
    case "FAILED":
      return ITEM_STATUS.FAILED;
    case "RETRY":
      return ITEM_STATUS.RETRY;
    case "PAUSED":
      return ITEM_STATUS.PAUSED;
    case "CANCELLED":
      return ITEM_STATUS.CANCELLED;
    default:
      return ITEM_STATUS.QUEUED;
  }
}

export function normalizeJobStatus(raw: string | null | undefined): JobStatus {
  switch ((raw ?? "").trim().toUpperCase()) {
    case "PENDING":
    case "QUEUED":
      return JOB_STATUS.QUEUED;
    case "RUNNING":
    case "PROCESSING":
      return JOB_STATUS.PROCESSING;
    case "COMPLETED":
      return JOB_STATUS.COMPLETED;
    case "FAILED":
      return JOB_STATUS.FAILED;
    case "PAUSED":
      return JOB_STATUS.PAUSED;
    case "CANCELLED":
      return JOB_STATUS.CANCELLED;
    default:
      return JOB_STATUS.QUEUED;
  }
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/** Exponential backoff (giây) cho item retry, có jitter. Không retry vô hạn. */
export function retryBackoffSeconds(attemptCount: number, baseMs = 2_000): number {
  const exp = Math.min(60_000, baseMs * 2 ** Math.max(0, attemptCount - 1));
  const jitter = Math.floor(Math.random() * Math.min(2_000, exp * 0.25));
  return Math.round((exp + jitter) / 1000);
}

/** Quyết định retry hay fail hẳn dựa trên số lần đã thử. */
export function shouldRetry(attemptCount: number, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): boolean {
  return attemptCount < maxAttempts;
}

/** Item terminal state (không còn claim/retry được nữa). */
export function isTerminalItemStatus(status: ItemStatus): boolean {
  return status === ITEM_STATUS.COMPLETED || status === ITEM_STATUS.FAILED || status === ITEM_STATUS.CANCELLED;
}

/** Job terminal state. */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === JOB_STATUS.COMPLETED || status === JOB_STATUS.FAILED || status === JOB_STATUS.CANCELLED;
}
