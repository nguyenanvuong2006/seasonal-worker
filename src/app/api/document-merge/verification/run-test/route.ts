/**
 * POST /api/document-merge/verification/run-test
 * E2E smoke: seed N hồ sơ TEST → tạo job (HTML_PDF) → trigger worker →
 * poll tới terminal → verify từng stage → soft-delete records test.
 *
 * Body: { records: 1 | 10 } — CHỈ 2 giá trị cố định, không arbitrary input.
 * Chỉ ADMIN + non-production (VERIFICATION_ENABLED=true).
 */

import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { dailyApplications, documentHistory, mergeJobRecords, mergeJobs } from "@/db/schema";
import { isVerificationEnabled, callWorker } from "@/lib/verification/helpers";
import { createAsyncMergeJob } from "@/lib/document-merge/async-job";

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
    const templateRows = await db.execute(sql`
      SELECT t.id FROM merge_templates t
      WHERE t.is_active = true
        AND EXISTS (SELECT 1 FROM merge_template_versions v
                    WHERE v.template_id = t.id AND v.status = 'PUBLISHED')
      ORDER BY t.created_at LIMIT 1
    `);
    const templateId = (templateRows as unknown as { rows?: { id: string }[] }).rows?.[0]?.id;
    if (!templateId) {
      return NextResponse.json(
        { pass: false, error: "Chưa có template active + version PUBLISHED (HTML engine)." },
        { status: 409 },
      );
    }

    // 2. Seed N hồ sơ TEST (prefix VERIFY — không đụng data production)
    const tag = `VERIFY-${Date.now().toString(36)}`;
    const seeded: string[] = [];
    for (let i = 0; i < records; i++) {
      const [app] = await db
        .insert(dailyApplications)
        .values({
          cccd: `0722${String(100000000 + Math.floor(Math.random() * 899999999))}`,
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
    const triggered = await callWorker<{ processed?: number; failed?: number }>("/run", { jobId }, 30_000);
    stages.workerTrigger = { pass: triggered.ok, status: triggered.status, error: triggered.ok ? null : (triggered.data as { error?: string })?.error };

    // 5. Poll tới terminal (max 120s)
    let jobState: (typeof mergeJobs.$inferSelect) | null = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const rows = await db.select().from(mergeJobs).where(eq(mergeJobs.id, jobId)).limit(1);
      jobState = rows[0] ?? null;
      if (jobState && ["COMPLETED", "FAILED", "CANCELLED"].includes(jobState.status)) break;
    }
    if (!jobState) {
      stages.poll = { pass: false, error: "Job không tới terminal sau 120s." };
    } else {
      stages.poll = { pass: true, status: jobState.status, progressPercent: jobState.progressPercent };
    }

    // 6. Verify items + history
    const items = await db
      .select()
      .from(mergeJobRecords)
      .where(eq(mergeJobRecords.mergeJobId, jobId))
      .orderBy(mergeJobRecords.sortOrder);

    const completed = items.filter((i) => i.status === "COMPLETED");
    const failed = items.filter((i) => i.status === "FAILED");
    const retries = items.filter((i) => i.attemptCount > 1).length;
    const allHaveSha = completed.length > 0 && completed.every((i) => Boolean(i.sha256 && i.storageKey && i.documentHistoryId));

    const historyRows = await db
      .select()
      .from(documentHistory)
      .where(eq(documentHistory.mergeJobId, jobId));

    const historyOk =
      historyRows.length === completed.length &&
      historyRows.every((h) => Boolean(h.sha256 && h.storageFileId && h.templateVersion != null && h.retentionUntil));

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
      count: historyRows.length,
      templateVersion: historyRows[0]?.templateVersion ?? null,
      retentionUntil: historyRows[0]?.retentionUntil ?? null,
      archiveStatus: historyRows[0]?.archiveStatus ?? null,
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
