/**
 * POST /api/document-merge/verification/check-1record-seed
 *
 * "Check 1-record Seed" — CLAIM_STALLED root-cause investigation (STAGING
 * only). Check Queue (check-queue/route.ts) đã chứng minh: DB identity khớp
 * VÀ claimItems() hoạt động đúng khi worker TỰ seed + TỰ claim trên CÙNG 1
 * connection (runClaimProbe ở queue-diagnostics.ts). Điều đó KHÔNG kiểm tra
 * được lệch pha cross-process: Vercel ghi (1 connection) → Cloud Run worker
 * đọc/claim (connection KHÁC, qua network) — đúng đường đi /run thật.
 *
 * Diagnostic này tái tạo CHÍNH XÁC đường đi Run 1-record Test dùng:
 *   1. Seed 1 hồ sơ TEST + gọi ĐÚNG createAsyncMergeJob() (helper production
 *      thật — KHÔNG dùng bản rút gọn của Check Queue probe).
 *   2. Đánh giá eligibility CỤC BỘ (Vercel connection, chỉ ĐỌC — không claim,
 *      không tiêu thụ item) — chứng minh contract seed tạo ra row đúng.
 *   3. Gọi worker /diag/claim-existing — worker (connection RIÊNG, qua HTTP,
 *      giống hệt /run thật) claim item Vercel VỪA tạo — bài test THẬT cho
 *      race/visibility cross-process.
 *   4. Dọn dẹp: soft-delete hồ sơ test + xoá cứng job/item diagnostic.
 *
 * Chỉ ADMIN + non-production (VERIFICATION_ENABLED=true). Không expose secret.
 */

import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { dailyApplications, mergeJobRecords, mergeJobs } from "@/db/schema";
import { isVerificationEnabled, callWorker } from "@/lib/verification/helpers";
import { createAsyncMergeJob } from "@/lib/document-merge/async-job";
import { findHtmlPublishableTemplateId } from "@/lib/document-merge/template-versions";
import { evaluateClaimEligibility } from "@/lib/document-merge/queue-diagnostics";
import type { ClaimExistingReport } from "@/lib/document-merge/queue-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN"], "document_merge.execute");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!isVerificationEnabled()) {
    return NextResponse.json({ error: "Verification chỉ khả dụng ở non-production." }, { status: 403 });
  }

  const startedAt = Date.now();
  let testAppId: string | null = null;
  let jobId: string | null = null;

  try {
    // 1. Template active + có version PUBLISHED — ĐÚNG điều kiện Run 1-record Test dùng.
    const templateId = await findHtmlPublishableTemplateId();
    if (!templateId) {
      return NextResponse.json(
        {
          pass: false,
          stage: "TEMPLATE",
          error: "Chưa có template active + version PUBLISHED (HTML engine).",
        },
        { status: 409 },
      );
    }

    // 2. Seed 1 hồ sơ TEST — CÙNG shape với Run 1-record Test (route.ts) dùng.
    const tag = `[STAGING-1RECORD-SEED] ${Date.now().toString(36)}`;
    const [app] = await db
      .insert(dailyApplications)
      .values({
        cccd: `0722${String(10000000 + Math.floor(Math.random() * 89999999))}`,
        fullName: `${tag} Ứng viên`,
        gender: "Nam",
        dob: "2001-03-15",
        phone: `091${String(1000000 + Math.floor(Math.random() * 8999999))}`,
        permanentAddress: "Địa chỉ test, Đà Lạt",
        residentialAddress: "Địa chỉ test, Đà Lạt",
        declaredType: "NEW",
        dwMatch: "NO_MATCH",
        status: "ASSIGNED",
        regDate: "2026-08-17",
        startingDate: "2026-09-01",
        customAnswers: {},
      })
      .returning({ id: dailyApplications.id });
    testAppId = app.id;

    // 3. Tạo job — ĐÚNG helper production thật createAsyncMergeJob(), KHÔNG
    // phải bản rút gọn (đây chính là điều Phase 1/2 yêu cầu: tái sử dụng
    // contract thật, không tự viết 1 insert khác có thể che giấu khác biệt).
    const job = await createAsyncMergeJob({
      templateId,
      autoRoute: false,
      records: { entityType: "daily_applications", recordIds: [app.id] },
      createdBy: `verification-seed-diag-${guard.session.username}`,
      scopeDeptIds: null,
      mergeMode: "INDIVIDUAL_DOCUMENTS",
      dispatchToApplicant: false,
      engine: "HTML_PDF",
    });
    jobId = job.jobId;

    const itemRows = await db
      .select({ id: mergeJobRecords.id })
      .from(mergeJobRecords)
      .where(eq(mergeJobRecords.mergeJobId, jobId));
    const itemId = itemRows[0]?.id ?? null;

    if (!itemId) {
      return NextResponse.json({
        pass: false,
        stage: "SEED",
        error: "createAsyncMergeJob() không tạo ra item nào — không thể tiếp tục claim probe.",
        jobId,
        durationMs: Date.now() - startedAt,
      });
    }

    // 4. Eligibility CỤC BỘ (Vercel connection) — CHỈ ĐỌC, KHÔNG claim (không
    // tiêu thụ item — worker ở bước 5 phải là bên THẬT SỰ claim, đúng đường
    // đi production; nếu Vercel tự claim trước thì bài test cross-process vô nghĩa).
    const eligibilityFromVercel = await evaluateClaimEligibility(db, jobId, itemId);

    // 5. Worker claim (connection RIÊNG, qua HTTP — đúng /run thật) item Vercel vừa tạo.
    const claimResult = await callWorker<ClaimExistingReport>(
      "/diag/claim-existing",
      { jobId },
      30_000,
      { request },
    );
    if (!claimResult.ok) {
      return NextResponse.json({
        pass: false,
        stage: claimResult.stage ?? "CLAIM_EXISTING_UNREACHABLE",
        error: (claimResult.data as { error?: string }).error ?? `HTTP ${claimResult.status}`,
        jobId,
        itemId,
        eligibilityFromVercel,
        durationMs: Date.now() - startedAt,
      });
    }
    const workerClaim = claimResult.data as ClaimExistingReport;

    const pass = workerClaim.boundary === "E_CLAIM_SUCCEEDED";

    return NextResponse.json({
      pass,
      stage: "SEED_AND_CLAIM",
      jobId,
      itemId,
      // Eligibility đánh giá TRÊN CÙNG item, từ 2 connection khác nhau — nếu
      // 2 kết quả này LỆCH NHAU (vd Vercel thấy statusEligible=true nhưng
      // worker's eligibilityBeforeClaim thấy false), đó CHÍNH LÀ bằng chứng
      // race/visibility cross-process (Phase 4 hypothesis) — không cần đoán.
      eligibilityFromVercel,
      workerClaim,
      crossProcessEligibilityMatches:
        workerClaim.eligibilityBeforeClaim !== null &&
        JSON.stringify(eligibilityFromVercel) === JSON.stringify(workerClaim.eligibilityBeforeClaim),
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json({
      pass: false,
      error: error instanceof Error ? error.message.slice(0, 400) : String(error),
      jobId,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    // Dọn dẹp: soft-delete hồ sơ test (giữ audit trail, giống Run 1-record
    // Test) + xoá CỨNG job/item diagnostic (không để lại "job giả" trong
    // lịch sử job thật — khác Run 1-record Test vốn CỐ Ý giữ lại job để xem).
    if (jobId) {
      await db.delete(mergeJobRecords).where(eq(mergeJobRecords.mergeJobId, jobId)).catch(() => undefined);
      await db.delete(mergeJobs).where(eq(mergeJobs.id, jobId)).catch(() => undefined);
    }
    if (testAppId) {
      await db
        .update(dailyApplications)
        .set({ deletedAt: new Date(), deletedBy: "verification-cleanup" })
        .where(and(inArray(dailyApplications.id, [testAppId]), isNull(dailyApplications.deletedAt)))
        .catch(() => undefined);
    }
  }
}
