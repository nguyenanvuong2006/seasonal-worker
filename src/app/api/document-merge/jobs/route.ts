/**
 * Document Merge — async jobs API (Phase 1).
 *
 * POST /api/document-merge/jobs
 *   Chỉ tạo job + items rồi trả jobId ngay. KHÔNG render 500 hồ sơ trong request.
 *   Body: { templateId?, autoRoute?, mergeMode?, dispatchToApplicant?,
 *           records: { entityType, recordIds } }
 *   Response: { jobId, status: "QUEUED", total, engine }
 *
 * GET /api/document-merge/jobs
 *   Danh sách job gần đây + progress (cho Progress UI Phase 7).
 */

import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { requirePermission, writeAudit, getUserScope } from "@/lib/auth";
import { db } from "@/db";
import { mergeJobs } from "@/db/schema";
import { createAsyncMergeJob, AsyncJobValidationError } from "@/lib/document-merge/async-job";
import { triggerPdfWorker } from "@/lib/document-merge/worker-trigger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.execute");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const body = await request.json();
    const { templateId, autoRoute, mergeMode, dispatchToApplicant, records, signingContext } = body as {
      templateId?: string;
      autoRoute?: boolean;
      mergeMode?: "ONE_DOCUMENT" | "INDIVIDUAL_DOCUMENTS";
      dispatchToApplicant?: boolean;
      records?: { entityType: string; recordIds: string[] };
      signingContext?: unknown;
    };

    if (!records?.recordIds?.length) {
      return NextResponse.json({ error: "Cần chọn ít nhất 1 hồ sơ để merge." }, { status: 400 });
    }

    const scope = await getUserScope(guard.session);
    const result = await createAsyncMergeJob({
      templateId: templateId ?? null,
      autoRoute,
      mergeMode,
      dispatchToApplicant,
      records: { entityType: records.entityType || "daily_applications", recordIds: records.recordIds },
      createdBy: guard.session.username,
      scopeDeptIds: scope,
      // H3 — resolved once by the caller (Preview/UI) and frozen ONCE into
      // this job's immutable metadata by createAsyncMergeJob itself.
      signingContext,
    });

    await writeAudit(guard.session, "CREATE_MERGE_JOB", "merge_jobs", {
      jobId: result.jobId,
      engine: result.engine,
      recordCount: result.total,
      autoRoute: Boolean(autoRoute),
    });

    // HTML/PDF jobs reuse the durable merge_jobs/merge_job_records queue and
    // the existing authenticated Cloud Run trigger. GOOGLE_DOCS jobs retain
    // their legacy execution path and are never claimed by this worker.
    if (result.engine === "HTML_PDF") {
      triggerPdfWorker(result.jobId, request);
    }

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof AsyncJobValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/jobs] POST error:", error);
    return NextResponse.json({ error: "Không thể tạo merge job." }, { status: 500 });
  }
}

export async function GET() {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const jobs = await db
      .select({
        id: mergeJobs.id,
        templateNameSnapshot: mergeJobs.templateNameSnapshot,
        status: mergeJobs.status,
        engine: mergeJobs.engine,
        recordCount: mergeJobs.recordCount,
        queuedCount: mergeJobs.queuedCount,
        processingCount: mergeJobs.processingCount,
        completedCount: mergeJobs.completedCount,
        failedCount: mergeJobs.failedCount,
        progressPercent: mergeJobs.progressPercent,
        outputPdfUrl: mergeJobs.outputPdfUrl,
        outputZipUrl: mergeJobs.outputZipUrl,
        createdBy: mergeJobs.createdBy,
        startedAt: mergeJobs.startedAt,
        completedAt: mergeJobs.completedAt,
        createdAt: mergeJobs.createdAt,
      })
      .from(mergeJobs)
      .orderBy(desc(mergeJobs.createdAt))
      .limit(100);

    return NextResponse.json(jobs);
  } catch (error) {
    console.error("[document-merge/jobs] GET error:", error);
    return NextResponse.json({ error: "Failed to fetch merge jobs" }, { status: 500 });
  }
}
