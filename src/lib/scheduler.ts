import "server-only";
import { eq } from "drizzle-orm";
import { db, pool } from "@/db";
import { scheduledJobs } from "@/db/schema";
import { processNotificationQueue } from "@/lib/notifications";
import { findStalledJobs, runNextStep } from "@/lib/import-jobs";
import { cleanupTerminalStaging } from "@/lib/import-staging-cleanup";
import { recomputeRequestKpiCache } from "@/lib/workforce-request";
import { scanExpiredRequestsAndCreateTasks } from "@/lib/planning-reallocation";

/**
 * SCHEDULER FOUNDATION (nền tảng, #15)
 * --------------------------------------
 * Danh sách "job" (handlerKey) đăng ký sẵn trong code; LỊCH chạy + trạng thái
 * lưu ở bảng scheduled_jobs, quản lý bật/tắt tại /admin/system. Việc "đánh
 * thức" job KHÔNG dùng cron nội bộ (Vercel serverless không chạy tiến trình
 * nền liên tục) — dùng Vercel Cron (xem vercel.json) gọi vào /api/cron/run,
 * hoặc 1 dịch vụ cron ngoài miễn phí (cron-job.org) nếu gói Vercel đang dùng
 * không hỗ trợ Cron tần suất cao (Hobby chỉ 1 lần/ngày — xem ghi chú watchdog).
 */

const HANDLERS: Record<string, () => Promise<Record<string, unknown>>> = {
  PROCESS_NOTIFICATION_QUEUE: async () => {
    return processNotificationQueue(200);
  },
  EXPIRE_PLANNING_PERIODS: async () => {
    // PLANNING (Phase 2, Step 4) — "Nếu kế hoạch hết hạn → Expired" (tự động, theo ngày hệ thống).
    const result = await pool.query(`
      UPDATE planning_periods SET status = 'EXPIRED', updated_at = now()
      WHERE status = 'ACTIVE' AND end_date < CURRENT_DATE
    `);
    return { expired: result.rowCount ?? 0 };
  },
  RESUME_STALLED_IMPORT_JOBS: async () => {
    // IMPORT ENGINE v3 — WATCHDOG: Job RUNNING/QUEUED nhưng không có heartbeat > 90s (invocation
    // "chain" trước đó chết giữa chừng — deploy mới, cold start lỗi, mất mạng...). Gọi trực tiếp
    // runNextStep() trong CÙNG tiến trình (không qua HTTP self-call, tránh phải biết base URL từ
    // context cron) — lặp tới khi xong HOẶC gần hết maxDuration (chừa 15s an toàn), invocation cron
    // kế tiếp sẽ tiếp tục nếu chưa xong. Lưu ý: Vercel Hobby giới hạn Cron 1 lần/ngày — watchdog
    // vẫn hoạt động nhưng độ trễ phát hiện Job treo có thể tới 24h; nút "Resume" thủ công trong UI
    // (xem /admin/import-data) là đường phục hồi CHÍNH, nhanh hơn nhiều — watchdog chỉ là lưới an
    // toàn cho trường hợp không ai để ý quay lại xem.
    const stalled = await findStalledJobs();
    const deadline = Date.now() + 45_000;
    let resumed = 0;
    for (const job of stalled) {
      if (Date.now() > deadline) break;
      let done = false;
      while (!done && Date.now() < deadline) {
        const r = await runNextStep(job.id);
        done = r.done;
      }
      resumed++;
    }
    return { stalledFound: stalled.length, resumed };
  },
  EXPIRE_RECRUITMENT_REQUESTS: async () => {
    // PLANNING — YÊU CẦU TUYỂN DỤNG HẾT HẠN (Yêu cầu #7, #13, #14).
    //
    // Quét các Recruitment Request đã quá End Date, chuyển sang EXPIRED
    // (KHÔNG BAO GIỜ là CANCELLED) và tạo Task Center nhắc Recruiter chuyển
    // phân bổ DW sang yêu cầu mới.
    //
    // QUAN TRỌNG: handler này TUYỆT ĐỐI KHÔNG đụng tới employment_sessions
    // hay workforce_movements. Yêu cầu hết hạn KHÔNG phải DW nghỉ việc —
    // chỉ Workforce Movement loại RESIGNATION mới là nghỉ việc thật.
    //
    // Idempotent: unique index partial planning_tasks_open_uq + onConflictDoNothing
    // đảm bảo chạy lại (cron trùng, retry) không sinh task trùng.
    return scanExpiredRequestsAndCreateTasks() as unknown as Promise<Record<string, unknown>>;
  },
  CLEANUP_IMPORT_STAGING: async () => {
    // IMPORT ENGINE v3 — STAGING RETENTION: staging là temporary workspace, không phải
    // historical storage. Dọn staging_* của job DONE/CANCELLED đã terminal > 24h (xem
    // src/lib/import-staging-cleanup.ts — idempotent, self-guarding, không đụng
    // import_jobs/import_job_errors/audit_logs hay bảng nghiệp vụ). Chạy qua scheduler
    // hiện có (Vercel Cron / cron ngoài gọi /api/cron/run) — không thêm dịch vụ mới.
    return cleanupTerminalStaging(100);
  },
  RECOVER_STALE_MERGE_JOBS: async () => {
    // DOCUMENT MERGE WATCHDOG:
    //  - GOOGLE_DOCS (default) merge is SYNCHRONOUS — the HTTP request owns
    //    RUNNING/PENDING rows and there is no worker to resume it. If the
    //    serverless function is hard-killed mid-flight (platform timeout /
    //    hung Google fetch) the catch that marks FAILED never runs and the
    //    job is stuck "PROCESSING / Queued=1" forever. These are failed loudly.
    //  - HTML_PDF is async but the ONLY dispatch is a single fire-and-forget
    //    after() call at job creation; if it dies the QUEUED job has no other
    //    trigger. Orphaned jobs get a fresh worker dispatch here (trigger uses
    //    after(), safe to call inside this cron request), and stale PROCESSING
    //    items (dead worker) are reclaimed to RETRY.
    // NOTE: this cron is DAILY (Vercel Hobby caps cron at 1/day). The same
    // sweep additionally runs interactively at the start of
    // POST /api/document-merge/merge/execute (pre-merge-recovery.ts), so a
    // zombie is closed the next time anyone merges — never up to 24h.
    // Dynamic imports keep the worker-auth/after() modules out of any unrelated
    // module graph and out of the minimal cron route import surface.
    const { recoverStaleMergeJobs } = await import("@/lib/document-merge/stale-recovery");
    const { triggerPdfWorker } = await import("@/lib/document-merge/worker-trigger");
    const result = await recoverStaleMergeJobs({
      fire: (jobId) => triggerPdfWorker(jobId),
    });
    return {
      syncFailed: result.syncFailed,
      processingReclaimed: result.processingReclaimed,
      redispatched: result.dispatchJobIds.length,
    };
  },
  RECOMPUTE_REQUEST_KPI_CACHE: async () => {
    // WORKFORCE REQUEST LINKAGE (mục 9) — recompute job cho KPI cache: tính lại KPI
    // của mọi Workforce Request chưa xoá và upsert vào request_kpi_cache (có timestamp).
    // Cache KHÔNG phải source of truth — chỉ tăng tốc dashboard; mọi quyết định
    // allocation đều tính live trong transaction.
    const count = await recomputeRequestKpiCache();
    return { recomputed: count };
  },
};

export const DEFAULT_SCHEDULED_JOBS: { jobKey: string; label: string; schedule: string; handlerKey: string }[] = [
  { jobKey: "process_notifications", label: "Xử lý hàng đợi thông báo", schedule: "daily", handlerKey: "PROCESS_NOTIFICATION_QUEUE" },
  { jobKey: "expire_planning_periods", label: "Tự động hết hạn kế hoạch Planning", schedule: "daily", handlerKey: "EXPIRE_PLANNING_PERIODS" },
  { jobKey: "resume_stalled_import_jobs", label: "Watchdog: phục hồi Import Job bị treo", schedule: "daily", handlerKey: "RESUME_STALLED_IMPORT_JOBS" },
  { jobKey: "expire_recruitment_requests", label: "Yêu cầu tuyển dụng hết hạn → EXPIRED + Task tái phân bổ", schedule: "daily", handlerKey: "EXPIRE_RECRUITMENT_REQUESTS" },
  { jobKey: "cleanup_import_staging", label: "Dọn staging của Import Job đã hoàn tất/huỷ (>24h)", schedule: "daily", handlerKey: "CLEANUP_IMPORT_STAGING" },
  { jobKey: "recompute_request_kpi_cache", label: "Recompute KPI cache của Workforce Request", schedule: "hourly", handlerKey: "RECOMPUTE_REQUEST_KPI_CACHE" },
  { jobKey: "recover_stale_merge_jobs", label: "Watchdog: phục hồi Merge Job bị treo (GOOGLE_DOCS kẹt PROCESSING)", schedule: "daily", handlerKey: "RECOVER_STALE_MERGE_JOBS" },
];

/** Chạy toàn bộ job đang Active — gọi từ /api/cron/run. */
export async function runDueJobs() {
  const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.isActive, true));
  const results: { jobKey: string; status: string }[] = [];
  for (const job of jobs) {
    const handler = HANDLERS[job.handlerKey];
    if (!handler) {
      results.push({ jobKey: job.jobKey, status: "NO_HANDLER" });
      continue;
    }
    try {
      await handler();
      await db
        .update(scheduledJobs)
        .set({ lastRunAt: new Date(), lastStatus: "OK" })
        .where(eq(scheduledJobs.id, job.id));
      results.push({ jobKey: job.jobKey, status: "OK" });
    } catch (e) {
      await db
        .update(scheduledJobs)
        .set({ lastRunAt: new Date(), lastStatus: "FAILED" })
        .where(eq(scheduledJobs.id, job.id));
      results.push({ jobKey: job.jobKey, status: "FAILED: " + (e as Error).message });
    }
  }
  return results;
}
