import "server-only";
import { db, pool } from "@/db";
import { auditLogs } from "@/db/schema";

/**
 * IMPORT ENGINE v3 — STAGING RETENTION & CLEANUP
 * ------------------------------------------------
 * Staging (staging_department / staging_dw_data / staging_daily_application) là TEMPORARY
 * WORKSPACE của pipeline import, KHÔNG phải historical storage. Sau khi Job đạt terminal
 * state, staging rows chỉ còn chiếm chỗ — lịch sử nghiệp vụ đã nằm ở import_jobs (số liệu
 * tổng hợp), import_job_errors (log lỗi từng dòng, nguồn của nút Download Log) và các bảng
 * chính (dw_data / daily_applications / departments).
 *
 * QUY TẮC RETENTION (thứ tự ưu tiên an toàn):
 *   - DONE      > 24h kể từ finished_at  → được dọn staging.
 *   - CANCELLED > 24h kể từ updated_at   → được dọn staging. TIỀN ĐỀ BẮT BUỘC: Cancel là
 *     TERMINAL STATE — route Retry đã chặn CANCELLED (không Resume/Retry được nữa), nên
 *     không còn luồng nào đọc staging của job đã huỷ.
 *   - QUEUED / RUNNING / PAUSED / FAILED: TUYỆT ĐỐI KHÔNG DỌN — Retry/Resume/watchdog cần
 *     staging + metadata.mergeCursor để chạy tiếp từ đúng chỗ dừng.
 *
 * AN TOÀN:
 *   - CHỈ xoá 3 bảng staging_*. KHÔNG BAO GIỜ đụng import_jobs, import_job_errors,
 *     audit_logs hay bảng nghiệp vụ (dw_data / daily_applications / departments).
 *   - Mỗi câu DELETE tự bảo vệ (self-guarding): JOIN import_jobs ngay trong DELETE, chỉ xoá
 *     khi status vẫn là DONE/CANCELLED và đã quá hạn retention TẠI THỜI ĐIỂM XOÁ — kể cả
 *     race hiếm (job vừa được đổi trạng thái giữa lúc chọn và lúc xoá) cũng không thể xoá
 *     nhầm staging của job đang sống.
 *   - Idempotent: chạy lại bao nhiêu lần cũng được — DELETE lần sau khớp 0 dòng, không lỗi.
 *   - Không chạy trong transaction MERGING: cleanup chỉ được gọi từ scheduled job
 *     (scheduler → Vercel Cron / cron ngoài), sau khi job đã terminal > 24h.
 */

export const STAGING_RETENTION_HOURS = 24;

/** Điều kiện job terminal đủ hạn dọn — dùng chung cho SELECT ứng viên và guard trong DELETE.
 *  CANCELLED không có finished_at (route Cancel chỉ set status + updated_at) nên dùng
 *  coalesce(finished_at, updated_at) làm mốc terminal. */
const TERMINAL_EXPIRED_SQL = `j.status IN ('DONE','CANCELLED') AND coalesce(j.finished_at, j.updated_at) < now() - interval '${STAGING_RETENTION_HOURS} hours'`;

const STAGING_TABLES = ["staging_department", "staging_dw_data", "staging_daily_application"] as const;

export type StagingCleanupResult = {
  jobId: string;
  jobType: string;
  status: string;
  fileName: string;
  deletedDepartment: number;
  deletedDwData: number;
  deletedDailyApplication: number;
  deletedTotal: number;
};

/** Job terminal quá hạn retention và CÒN staging rows (job đã dọn rồi sẽ không được chọn lại
 *  nhờ điều kiện EXISTS — tự nhiên idempotent ở tầng chọn ứng viên). */
export async function findStagingCleanupCandidates(limit = 100): Promise<{ id: string; jobType: string; status: string; fileName: string }[]> {
  const res = await pool.query(
    `SELECT j.id, j.job_type, j.status, j.file_name
     FROM import_jobs j
     WHERE ${TERMINAL_EXPIRED_SQL}
       AND (
         EXISTS (SELECT 1 FROM staging_department s WHERE s.job_id = j.id) OR
         EXISTS (SELECT 1 FROM staging_dw_data s WHERE s.job_id = j.id) OR
         EXISTS (SELECT 1 FROM staging_daily_application s WHERE s.job_id = j.id)
       )
     ORDER BY coalesce(j.finished_at, j.updated_at) ASC
     LIMIT $1`,
    [limit],
  );
  return res.rows.map((r: { id: string; job_type: string; status: string; file_name: string }) => ({
    id: r.id,
    jobType: r.job_type,
    status: r.status,
    fileName: r.file_name,
  }));
}

/**
 * Dọn staging của ĐÚNG 1 job — idempotent, self-guarding. Trả về số dòng đã xoá từng bảng.
 * Transaction chỉ bao 3 câu DELETE staging (không khoá bảng nghiệp vụ nào).
 */
export async function cleanupJobStaging(jobId: string): Promise<{ deletedDepartment: number; deletedDwData: number; deletedDailyApplication: number; deletedTotal: number }> {
  const client = await pool.connect();
  const deleted: number[] = [];
  try {
    await client.query("BEGIN");
    for (const table of STAGING_TABLES) {
      const res = await client.query(
        `DELETE FROM ${table} s
         USING import_jobs j
         WHERE s.job_id = $1 AND j.id = s.job_id AND ${TERMINAL_EXPIRED_SQL}`,
        [jobId],
      );
      deleted.push(res.rowCount ?? 0);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const [deletedDepartment, deletedDwData, deletedDailyApplication] = deleted;
  return { deletedDepartment, deletedDwData, deletedDailyApplication, deletedTotal: deletedDepartment + deletedDwData + deletedDailyApplication };
}

/**
 * Entry point cho scheduler: dọn staging mọi job terminal quá hạn (mặc định tối đa 100
 * job/lượt — lượt cron kế tiếp dọn phần còn lại nếu nhiều hơn). Ghi structured log +
 * audit_logs (category IMPORT, username "system" vì chạy nền không có session) cho TỪNG job
 * thật sự có dòng bị xoá. Cũng chính cơ chế này dọn dữ liệu legacy hiện có trên production
 * (13.522 dòng DW + 822 dòng Daily của các job DONE, và các job CANCELLED sau khi semantics
 * terminal đã được chốt) — không cần script một lần riêng.
 */
export async function cleanupTerminalStaging(limit = 100): Promise<{ candidates: number; cleaned: number; deletedRows: number; results: StagingCleanupResult[] }> {
  const candidates = await findStagingCleanupCandidates(limit);
  const results: StagingCleanupResult[] = [];
  let deletedRows = 0;

  for (const job of candidates) {
    const counts = await cleanupJobStaging(job.id);
    if (counts.deletedTotal === 0) continue; // race/đã dọn — bỏ qua, không log rác
    deletedRows += counts.deletedTotal;
    const result: StagingCleanupResult = { jobId: job.id, jobType: job.jobType, status: job.status, fileName: job.fileName, ...counts };
    results.push(result);

    // Structured log (parse được trên Vercel Logs) + audit trail bền vững trong DB.
    console.log(JSON.stringify({ event: "import_staging_cleaned", ...result }));
    try {
      await db.insert(auditLogs).values({
        userId: null,
        username: "system",
        action: "IMPORT_STAGING_CLEANED",
        targetType: "import_jobs",
        category: "IMPORT",
        details: result as unknown as Record<string, unknown>,
      });
    } catch {
      /* audit không được làm hỏng cleanup — structured log ở trên vẫn còn */
    }
  }

  return { candidates: candidates.length, cleaned: results.length, deletedRows, results };
}
