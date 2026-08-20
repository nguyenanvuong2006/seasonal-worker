/**
 * Document Merge — direct claim probe (STAGING/verification only).
 *
 * KHÔNG đoán claimItems() có bug — seed 1 job + 1 item QUEUED thật (giống hệt
 * contract async-job.ts dùng: xem createAsyncMergeJob), đánh giá TỪNG
 * predicate claimItems() dùng một cách độc lập, rồi gọi ĐÚNG claimItems() thật
 * (không phải bản rút gọn) để phân biệt rõ ranh giới lỗi:
 *
 *   A_NOT_ELIGIBLE                          — item bị 1 predicate loại trừ
 *                                              (chứng minh predicate nào).
 *   B_ELIGIBLE_BUT_ROW_UNCHANGED             — mọi predicate đều pass nhưng
 *                                              row KHÔNG chuyển PROCESSING
 *                                              (CTE SELECT...FOR UPDATE SKIP
 *                                              LOCKED không chọn được candidate,
 *                                              hoặc UPDATE...FROM không match).
 *   C_ROW_UPDATED_BUT_CLAIMITEMS_RETURNED_EMPTY — row THẬT SỰ đã chuyển
 *                                              PROCESSING (UPDATE chạy đúng)
 *                                              nhưng claimItems() (JS) trả về
 *                                              mảng rỗng — lỗi decode RETURNING.
 *   E_CLAIM_SUCCEEDED                        — claim thành công bình thường.
 *
 * Dọn dẹp: xoá job+item probe ngay sau khi đọc xong (finally) — không để lại
 * rác trong queue thật, không ảnh hưởng job người dùng.
 *
 * LƯU Ý: claimItems() không có predicate nào liên quan attempt_count/
 * max_attempts (xem queue.ts) — attempt_count chỉ được dùng SAU khi item đã
 * FAILED (failItem() quyết định RETRY vs FAILED). Diagnostic này KHÔNG bịa ra
 * field "attemptsEligible" không tồn tại trong SQL thật.
 */

import { sql, eq, type SQLWrapper } from "drizzle-orm";
import { mergeJobs, mergeJobRecords } from "../../db/schema";
import { claimItems } from "./queue.ts";

export interface ClaimEligibility {
  itemExists: boolean;
  jobIdMatches: boolean;
  status: string | null;
  /** predicate: status IN ('QUEUED','RETRY') */
  statusEligible: boolean;
  attemptCount: number | null;
  leasedUntil: string | null;
  /** predicate: leased_until IS NULL OR leased_until < now() */
  leaseEligible: boolean;
  retryAt: string | null;
  /** predicate: retry_at IS NULL OR retry_at <= now() */
  retryEligible: boolean;
  createdAt: string | null;
  /** AND của mọi predicate ở trên (đúng thứ tự claimItems() dùng). */
  overallClaimEligible: boolean;
}

export type ClaimProbeBoundary =
  | "A_NOT_ELIGIBLE"
  | "B_ELIGIBLE_BUT_ROW_UNCHANGED"
  | "C_ROW_UPDATED_BUT_CLAIMITEMS_RETURNED_EMPTY"
  | "E_CLAIM_SUCCEEDED";

export interface ClaimProbeReport {
  jobId: string;
  itemId: string;
  eligibilityBeforeClaim: ClaimEligibility;
  claimItemsReturnedCount: number;
  claimItemsReturnedItemMatches: boolean;
  rawRowAfterClaim: { status: string; leasedUntil: string | null; attemptCount: number } | null;
  boundary: ClaimProbeBoundary;
  cleanupOk: boolean;
  cleanupError: string | null;
}

export interface DiagnosticDb {
  execute: (query: string | SQLWrapper) => Promise<{ rows: unknown[] }>;
  insert: typeof import("../../db").db.insert;
  delete: typeof import("../../db").db.delete;
}

/** Đánh giá ĐỘC LẬP từng predicate claimItems() dùng cho 1 item cụ thể — KHÔNG khoá row (không FOR UPDATE). */
export async function evaluateClaimEligibility(database: DiagnosticDb, jobId: string, itemId: string): Promise<ClaimEligibility> {
  const result = await database.execute(sql`
    SELECT
      merge_job_id,
      status,
      attempt_count,
      leased_until,
      retry_at,
      created_at,
      (status IN ('QUEUED', 'RETRY')) AS status_eligible,
      (leased_until IS NULL OR leased_until < now()) AS lease_eligible,
      (retry_at IS NULL OR retry_at <= now()) AS retry_eligible
    FROM merge_job_records
    WHERE id = ${itemId}
  `);
  const row = result.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) {
    return {
      itemExists: false,
      jobIdMatches: false,
      status: null,
      statusEligible: false,
      attemptCount: null,
      leasedUntil: null,
      leaseEligible: false,
      retryAt: null,
      retryEligible: false,
      createdAt: null,
      overallClaimEligible: false,
    };
  }
  const jobIdMatches = row.merge_job_id === jobId;
  const statusEligible = Boolean(row.status_eligible);
  const leaseEligible = Boolean(row.lease_eligible);
  const retryEligible = Boolean(row.retry_eligible);
  return {
    itemExists: true,
    jobIdMatches,
    status: String(row.status),
    statusEligible,
    attemptCount: Number(row.attempt_count),
    leasedUntil: row.leased_until ? new Date(row.leased_until as string).toISOString() : null,
    leaseEligible,
    retryAt: row.retry_at ? new Date(row.retry_at as string).toISOString() : null,
    retryEligible,
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : null,
    overallClaimEligible: jobIdMatches && statusEligible && leaseEligible && retryEligible,
  };
}

/**
 * Seed 1 job QUEUED + 1 item QUEUED (đúng contract createAsyncMergeJob dùng),
 * gọi ĐÚNG claimItems() thật, chứng minh ranh giới thất bại nếu có, rồi dọn dẹp.
 */
export async function runClaimProbe(database: DiagnosticDb): Promise<ClaimProbeReport> {
  const [job] = await database
    .insert(mergeJobs)
    .values({
      templateNameSnapshot: "Verification claim probe",
      mergeMode: "INDIVIDUAL_DOCUMENTS",
      status: "QUEUED",
      recordCount: 1,
      engine: "HTML_PDF",
      queuedCount: 1,
      createdBy: "verification-claim-probe",
      metadata: { engine: "HTML_PDF", templates: {}, verificationProbe: true },
    })
    .returning();

  const [item] = await database
    .insert(mergeJobRecords)
    .values({
      mergeJobId: job.id,
      sourceEntity: "verification_probe",
      sourceRecordId: "00000000-0000-0000-0000-000000000000",
      sortOrder: 1,
      status: "QUEUED",
      attemptCount: 0,
    })
    .returning();

  // Khai báo NGOÀI try/finally: finally chạy SAU khi try đã "return" (giá trị
  // trả về đã được tính xong) — nếu return object literal ngay trong try, việc
  // set cleanupOk/cleanupError trong finally sẽ KHÔNG phản ánh vào object đã
  // trả về. Dùng biến chung, gán trong try, cập nhật 2 field cleanup trong
  // finally, rồi return biến này ở CUỐI hàm (sau khi try/finally hoàn tất).
  let cleanupOk = true;
  let cleanupError: string | null = null;
  let report: ClaimProbeReport;
  try {
    const eligibilityBeforeClaim = await evaluateClaimEligibility(database, job.id, item.id);

    // ĐÚNG hàm production thật (worker.runJob() gọi hàm này) — không phải bản rút gọn.
    const claimed = await claimItems(job.id, 1);

    const rawAfterResult = await database.execute(sql`
      SELECT status, leased_until, attempt_count FROM merge_job_records WHERE id = ${item.id}
    `);
    const rawRow = rawAfterResult.rows?.[0] as Record<string, unknown> | undefined;
    const rawRowAfterClaim = rawRow
      ? {
          status: String(rawRow.status),
          leasedUntil: rawRow.leased_until ? new Date(rawRow.leased_until as string).toISOString() : null,
          attemptCount: Number(rawRow.attempt_count),
        }
      : null;

    const claimItemsReturnedCount = claimed.length;
    const claimItemsReturnedItemMatches = claimed.some((c) => c.id === item.id);
    const rowTransitionedToProcessing = rawRowAfterClaim?.status === "PROCESSING";

    let boundary: ClaimProbeBoundary;
    if (!eligibilityBeforeClaim.overallClaimEligible) {
      boundary = "A_NOT_ELIGIBLE";
    } else if (claimItemsReturnedItemMatches && rowTransitionedToProcessing) {
      boundary = "E_CLAIM_SUCCEEDED";
    } else if (!claimItemsReturnedItemMatches && rowTransitionedToProcessing) {
      boundary = "C_ROW_UPDATED_BUT_CLAIMITEMS_RETURNED_EMPTY";
    } else {
      boundary = "B_ELIGIBLE_BUT_ROW_UNCHANGED";
    }

    report = {
      jobId: job.id,
      itemId: item.id,
      eligibilityBeforeClaim,
      claimItemsReturnedCount,
      claimItemsReturnedItemMatches,
      rawRowAfterClaim,
      boundary,
      cleanupOk: true,
      cleanupError: null,
    };
  } finally {
    try {
      await database.delete(mergeJobRecords).where(eq(mergeJobRecords.mergeJobId, job.id));
      await database.delete(mergeJobs).where(eq(mergeJobs.id, job.id));
    } catch (error) {
      cleanupOk = false;
      cleanupError = error instanceof Error ? error.message.slice(0, 300) : String(error);
    }
  }
  report.cleanupOk = cleanupOk;
  report.cleanupError = cleanupError;
  return report;
}
