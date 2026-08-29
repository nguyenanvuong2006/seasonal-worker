/**
 * POST /api/document-merge/jobs/[id]/retry
 * Retry các item FAILED (đưa về RETRY — worker claim lại).
 * KHÔNG ảnh hưởng item COMPLETED. Job phải thuộc user (hoặc ADMIN/HR_DIRECTOR).
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { mergeJobs } from "@/db/schema";
import { requeueFailedItems } from "@/lib/document-merge/queue";
import { triggerPdfWorker } from "@/lib/document-merge/worker-trigger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.execute");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id } = await context.params;
    const [job] = await db.select().from(mergeJobs).where(eq(mergeJobs.id, id)).limit(1);
    if (!job) return NextResponse.json({ error: "Merge job not found" }, { status: 404 });
    if (job.createdBy !== guard.session.username && guard.session.role !== "ADMIN") {
      return NextResponse.json({ error: "Không có quyền retry job này." }, { status: 403 });
    }

    // The async retry/requeue semantics apply to BOTH worker-queue engines:
    // HTML_PDF and GOOGLE_DOCS (which moved onto the Cloud Run worker after
    // the 28–29/08 incident — items are claimed with SKIP LOCKED, so a RETRY
    // item WILL be picked up). Only legacy synchronous GOOGLE_DOCS zombies
    // (created before the async move) cannot be retried per item.
    const engine = job.engine ?? "GOOGLE_DOCS";
    if (engine !== "HTML_PDF" && engine !== "GOOGLE_DOCS") {
      return NextResponse.json(
        {
          success: false,
          error: `Engine "${engine}" không hỗ trợ retry theo item. Hãy chạy lại merge từ màn hình Merge.`,
        },
        { status: 400 },
      );
    }

    const count = await requeueFailedItems(id);
    if (count > 0) triggerPdfWorker(id, request); // không chờ — worker claim lại

    await writeAudit(guard.session, "RETRY_MERGE_JOB", "merge_jobs", { jobId: id, retriedItems: count });

    return NextResponse.json({ success: true, retriedItems: count, jobId: id });
  } catch (error) {
    console.error("[document-merge/jobs/[id]/retry] error:", error);
    return NextResponse.json({ error: "Failed to retry merge job" }, { status: 500 });
  }
}
