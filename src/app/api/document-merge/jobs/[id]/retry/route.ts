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

    // The async retry/requeue semantics only apply to the HTML_PDF queue
    // (Cloud Run worker claims RETRY items). Legacy GOOGLE_DOCS jobs are
    // synchronous: their request state is gone and nothing could claim a
    // RETRY item — requeuing would only create stuck rows. Tell the operator
    // to re-run the merge from the UI instead of pretending a retry fired.
    if ((job.engine ?? "GOOGLE_DOCS") !== "HTML_PDF") {
      return NextResponse.json(
        {
          success: false,
          error:
            "Job Google Docs (đồng bộ) không thể retry theo item. Hãy chạy lại merge cho hồ sơ này từ màn hình Merge — tài liệu mới sẽ được tạo, job cũ giữ FAILED để tra cứu.",
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
