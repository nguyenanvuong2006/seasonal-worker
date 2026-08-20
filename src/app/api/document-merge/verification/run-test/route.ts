/**
 * POST /api/document-merge/verification/run-test
 * E2E smoke: seed N hồ sơ TEST → tạo job (HTML_PDF) → trigger worker →
 * poll tới terminal → verify từng stage → soft-delete records test.
 *
 * Body: { records: 1 | 10 } — CHỈ 2 giá trị cố định, không arbitrary input.
 * Chỉ ADMIN + non-production (VERIFICATION_ENABLED=true).
 */

import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { dailyApplications, documentHistory, mergeJobRecords, mergeJobs } from "@/db/schema";
import { isVerificationEnabled, callWorker } from "@/lib/verification/helpers";
import { createAsyncMergeJob } from "@/lib/document-merge/async-job";
import { findHtmlPublishableTemplateId } from "@/lib/document-merge/template-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_RECORDS = [1, 10];

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN"], "document_merge.execute");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!isVerificationEnabled()) {
    return NextResponse.json({ error: "Verification chỉ khả dụng ở non-production." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { records?: number };
  const records = Number(body.records ?? 1);
  if (!ALLOWED_RECORDS.includes(records)) {
    return NextResponse.json({ error: "records phải là 1 hoặc 10." }, { status: 400 });
  }

  const stages: Record<string, unknown> = {};
  const startedAt = Date.now();
  let testAppIds: string[] = [];
  let jobId = "";

  try {
    // 1. Template active + có version PUBLISHED (HTML engine cần)
    const templateId = await findHtmlPublishableTemplateId();
    if (!templateId) {
      return NextResponse.json(
        {
          pass: false,
          error: "Chưa có template active + version PUBLISHED (HTML engine).",
          action:
            'Vào Document Merge Center → Quản lý Templates → chọn template active → Upload DOCX hoặc dán HTML để tạo version DRAFT → bấm "Xuất bản phiên bản".',
        },
        { status: 409 },
      );
    }

    // 2. Seed N hồ sơ TEST (prefix VERIFY — không đụng data production)
    const tag = `[STAGING-E2E] ${Date.now().toString(36)}`;
    const seeded: string[] = [];
    for (let i = 0; i < records; i++) {
      const [app] = await db
        .insert(dailyApplications)
        .values({
          cccd: `0722${String(10000000 + Math.floor(Math.random() * 89999999))}`,
          fullName: `${tag} Ứng viên ${i + 1}`,
          gender: "Nam",
          dob: "2001-03-15",
          phone: `091${String(1000000 + Math.floor(Math.random() * 8999999))}`,
          permanentAddress: `Địa chỉ test ${i + 1}, Đà Lạt`,
          residentialAddress: `Địa chỉ test ${i + 1}, Đà Lạt`,
          declaredType: "NEW",
          dwMatch: "NO_MATCH",
          status: "ASSIGNED",
          regDate: "2026-08-17",
          startingDate: "2026-09-01",
          customAnswers: {
            tien_an_tien_su: "Không",
            loai_cong_viec_truoc_day: "Nhân viên",
            khu_vuc_lam_viec_truoc_day: "Đà Lạt",
            cong_viec_hien_tai: "Sinh viên",
            ten_truong: "Trường Cao đẳng Đà Lạt",
            tinh_trang_tknh: "Đã có",
            so_tai_khoan: "0123456789012",
            ten_ngan_hang: "Vietcombank Lâm Đồng",
            nguon_thu_nhap: "Chỉ phát sinh tại Dalat Hasfarm",
            tap_nghe_nguyen_vong: "Trồng, chăm sóc, thu hoạch",
            cong_viec_khac: "",
            email: `verify${i + 1}@example.com`,
            so_dinh_danh_cu: "",
          },
        })
        .returning({ id: dailyApplications.id });
      seeded.push(app.id);
    }
    testAppIds = seeded;
    stages.seed = { pass: true, count: seeded.length };

    // 3. Tạo job (HTML_PDF)
    const job = await createAsyncMergeJob({
      templateId: templateId as string,
      autoRoute: false,
      records: { entityType: "daily_applications", recordIds: seeded },
      createdBy: `verification-${guard.session.username}`,
      scopeDeptIds: null,
      mergeMode: "INDIVIDUAL_DOCUMENTS",
      dispatchToApplicant: false,
      engine: "HTML_PDF",
    });
    jobId = job.jobId;
    stages.job = { pass: true, jobId, total: job.total, status: job.status };

    // 4. Trigger worker
    const triggered = await callWorker<{ processed?: number; failed?: number }>("/run", { jobId }, 30_000, { request });
    stages.workerTrigger = {
      pass: triggered.ok,
      status: triggered.status,
      stage: triggered.stage ?? null,
      error: triggered.ok ? null : (triggered.data as { error?: string })?.error,
      diagnostics: triggered.diagnostics ?? null,
    };

    // Trigger thất bại (401/403/404/lỗi cấu hình/network...) = job sẽ KHÔNG BAO
    // GIỜ tự chạy — polling 120s chỉ tốn thời gian chờ 1 kết quả không thể xảy
    // ra. Dừng ngay, trả lỗi trigger thật (stage) thay vì timeout mơ hồ.
    if (!triggered.ok) {
      stages.poll = { pass: false, skipped: true, reason: "Worker trigger thất bại — không polling job sẽ không bao giờ chạy." };
      stages.items = { pass: false, skipped: true, completed: 0, failed: 0 };
      stages.history = { pass: false, skipped: true, count: 0 };
      stages.finalize = { pass: false, skipped: true };

      return NextResponse.json({
        pass: false,
        records,
        jobId,
        totalDurationMs: Date.now() - startedAt,
        error: `Worker trigger thất bại (stage=${triggered.stage ?? "UNKNOWN"}, HTTP ${triggered.status}).`,
        stages,
      });
    }

    // 5. Poll tới terminal (max 120s)
    const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];
    let jobState: (typeof mergeJobs.$inferSelect) | null = null;
    let reachedTerminal = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const rows = await db.select().from(mergeJobs).where(eq(mergeJobs.id, jobId)).limit(1);
      jobState = rows[0] ?? null;
      if (jobState && TERMINAL_STATUSES.includes(jobState.status)) {
        reachedTerminal = true;
        break;
      }
    }

    // 6. Verify items + history (luôn truy vấn thật — querySucceeded tách biệt
    // khỏi verificationPassed: 1 query trả [] không có nghĩa "đã verify OK",
    // nó có nghĩa "chưa có gì để verify" — 2 điều khác nhau).
    const items = await db
      .select()
      .from(mergeJobRecords)
      .where(eq(mergeJobRecords.mergeJobId, jobId))
      .orderBy(mergeJobRecords.sortOrder);

    if (!reachedTerminal) {
      // Timeout khi vẫn PROCESSING/QUEUED — trả chẩn đoán thật (stage worker
      // cuối cùng, trạng thái từng item, lỗi an toàn) thay vì chỉ "chờ 120s
      // rồi báo lỗi mơ hồ".
      const lastWorkerStage = (jobState?.metadata as { lastStage?: unknown } | null | undefined)?.lastStage ?? null;
      stages.poll = {
        pass: false,
        querySucceeded: true,
        timedOut: true,
        jobStatus: jobState?.status ?? null,
        progressPercent: jobState?.progressPercent ?? null,
        lastWorkerStage,
        itemStatuses: items.map((i) => ({
          id: i.id,
          status: i.status,
          attemptCount: i.attemptCount,
          errorCode: i.errorCode ?? null,
          errorMessage: i.errorMessage ? i.errorMessage.slice(0, 200) : null,
        })),
        error: `Job không tới terminal sau 120s (trạng thái hiện tại: ${jobState?.status ?? "UNKNOWN"}, ${jobState?.progressPercent ?? 0}%).`,
      };
    } else {
      stages.poll = { pass: true, querySucceeded: true, status: jobState?.status ?? null, progressPercent: jobState?.progressPercent ?? null };
    }

    const completed = items.filter((i) => i.status === "COMPLETED");
    const failed = items.filter((i) => i.status === "FAILED");
    const retries = items.filter((i) => i.attemptCount > 1).length;
    const allHaveSha = completed.length > 0 && completed.every((i) => Boolean(i.sha256 && i.storageKey && i.documentHistoryId));

    const historyRows = await db
      .select()
      .from(documentHistory)
      .where(eq(documentHistory.mergeJobId, jobId));

    const retentionOk = historyRows.every((h) => {
      if (!h.retentionUntil) return false;
      const years = (h.retentionUntil.getTime() - (h.generatedAt ?? new Date()).getTime()) / 31557600000;
      return years >= 2 && years <= 4; // snapshot retention mặc định 3 năm
    });
    // QUAN TRỌNG: historyRows/completed rỗng-rỗng KHÔNG được coi là "khớp"
    // (0 === 0 là true toán học nhưng sai nghiệp vụ — "chưa xảy ra gì" không
    // phải "verify passed"). completed.length > 0 là điều kiện bắt buộc.
    const historyOk =
      completed.length > 0 &&
      historyRows.length === completed.length && // không duplicate history khi worker chạy lại
      historyRows.every((h) => Boolean(h.sha256 && h.storageFileId && h.templateVersion != null && h.retentionUntil)) &&
      retentionOk;

    const renderDurationMs =
      completed.length > 0
        ? completed.reduce((sum, i) => sum + (i.completedAt && i.startedAt ? i.completedAt.getTime() - i.startedAt.getTime() : 0), 0) /
          completed.length
        : null;

    stages.items = {
      pass: jobState?.status === "COMPLETED" && completed.length === records && failed.length === 0,
      completed: completed.length,
      failed: failed.length,
      retries,
      allHaveShaAndStorage: allHaveSha,
      avgRenderMs: renderDurationMs ? Math.round(renderDurationMs) : null,
    };
    stages.history = {
      pass: historyOk,
      querySucceeded: true,
      count: historyRows.length,
      expectedCount: completed.length,
      templateVersion: historyRows[0]?.templateVersion ?? null,
      retentionUntil: historyRows[0]?.retentionUntil ?? null,
      retentionOk,
      archiveStatus: historyRows[0]?.archiveStatus ?? null,
      storageProvider: historyRows[0]?.storageProvider ?? null,
      storageFileId: historyRows[0]?.storageFileId ?? null,
      fileSize: historyRows[0]?.fileSize ?? null,
      createdBy: historyRows[0]?.createdBy ?? null,
    };
    stages.finalize = {
      pass: Boolean(jobState?.outputPdfUrl && jobState?.outputZipUrl),
      outputPdfUrl: jobState?.outputPdfUrl ?? null,
      outputZipUrl: jobState?.outputZipUrl ?? null,
      batchExpiresAt: jobState?.batchExpiresAt ?? null,
    };

    const totalMs = Date.now() - startedAt;
    const stagePass = (s: unknown): boolean => Boolean(s && typeof s === "object" && (s as { pass?: boolean }).pass === true);
    const allPass =
      stagePass(stages.seed) &&
      stagePass(stages.job) &&
      stagePass(stages.workerTrigger) &&
      stagePass(stages.poll) &&
      stagePass(stages.items) &&
      stagePass(stages.history) &&
      stagePass(stages.finalize);

    return NextResponse.json({
      pass: allPass,
      records,
      jobId,
      totalDurationMs: totalMs,
      stages,
    });
  } catch (error) {
    return NextResponse.json({
      pass: false,
      records,
      jobId,
      totalDurationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 400) : String(error),
      stages,
    });
  } finally {
    // Soft-delete records test (không xoá cứng — giữ audit trail).
    if (testAppIds.length > 0) {
      await db
        .update(dailyApplications)
        .set({ deletedAt: new Date(), deletedBy: "verification-cleanup" })
        .where(and(inArray(dailyApplications.id, testAppIds), isNull(dailyApplications.deletedAt)))
        .catch(() => undefined);
    }
  }
}
