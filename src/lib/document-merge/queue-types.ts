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

/**
 * Worker processing stages — chẩn đoán an toàn (không bao giờ chứa dữ liệu
 * ứng viên/token/credentials), ghi vào merge_jobs.metadata.lastStage +
 * console.log structured, để 1 job kẹt PROCESSING luôn có dấu vết thay vì
 * "im lặng" (xem worker/src/index.ts recordStage()).
 */
export const WORKER_STAGES = [
  "JOB_CLAIMED",
  "ITEM_LOADING",
  "TEMPLATE_LOADING",
  "DATA_RESOLUTION",
  "HTML_RENDER",
  "CHROMIUM_LAUNCH",
  "PDF_RENDER",
  "SHA256",
  "STORAGE_UPLOAD",
  "HISTORY_WRITE",
  "ITEM_COMPLETE",
  "BATCH_FINALIZE",
  // GOOGLE_DOCS async engine (worker executor since the 28–29/08 incident).
  "GOOGLE_TEMPLATE_READ",
  "GOOGLE_DOC_CREATE",
  "GOOGLE_PDF_EXPORT",
  "GOOGLE_DRIVE_UPLOAD",
] as const;
export type WorkerStage = (typeof WORKER_STAGES)[number];

export interface WorkerStageEvent {
  stage: WorkerStage;
  itemId?: string | null;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  /** Mã lỗi ngắn, KHÔNG bao giờ chứa message/stack đầy đủ hay dữ liệu nhạy cảm. */
  errorCode?: string | null;
}

/**
 * Quyết định có nên thử claim lại hay không khi lần claim đầu tiên trả về 0
 * item dù job vẫn còn item QUEUED/RETRY (bất thường — không phải "hết việc
 * thật sự", vì recomputeJobProgress đã xác nhận còn item chưa terminal).
 * Thuần hàm — không I/O — để test được không cần DB thật.
 */
export function shouldRetryClaim(attempt: number, maxAttempts = 3): boolean {
  return attempt < maxAttempts;
}

/** Backoff (ms) giữa các lần retry claim — ngắn hơn nhiều so với item retry backoff. */
export function claimRetryDelayMs(attempt: number): number {
  return Math.min(2000, 250 * 2 ** Math.max(0, attempt - 1));
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/** Deterministic validation / configuration errors — never retry. */
export const NON_RETRYABLE_ERROR_CODES = [
  "INCOMPLETE",
  "INVALID_MAPPING",
  "INVALID_TEMPLATE",
  "UNSUPPORTED_SOURCE_PATH",
  "TEMPLATE_NOT_PUBLISHED",
  "RECORD_NOT_FOUND",
  "HTML_TEMPLATE_EMPTY",
  "HTML_TEMPLATE_MISSING",
  // Canonical pipeline configuration errors: retrying cannot publish a
  // template, so these must fail immediately instead of consuming attempts.
  "CANONICAL_TEMPLATE_NOT_PUBLISHED",
  "CANONICAL_SNAPSHOT_EMPTY",
] as const;

export type NonRetryableErrorCode = (typeof NON_RETRYABLE_ERROR_CODES)[number];

/** Transient infrastructure failures keep the existing backoff policy. */
export function isRetryableItemError(errorCode?: string | null, explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  if (!errorCode) return true;
  return !(NON_RETRYABLE_ERROR_CODES as readonly string[]).includes(errorCode);
}

/** Exponential backoff (giây) cho item retry, có jitter. Không retry vô hạn. */
export function retryBackoffSeconds(attemptCount: number, baseMs = 2_000): number {
  const exp = Math.min(60_000, baseMs * 2 ** Math.max(0, attemptCount - 1));
  const jitter = Math.floor(Math.random() * Math.min(2_000, exp * 0.25));
  return Math.round((exp + jitter) / 1000);
}

/** Quyết định retry hay fail hẳn dựa trên số lần đã thử (chỉ khi lỗi retryable). */
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
