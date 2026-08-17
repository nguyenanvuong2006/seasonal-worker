/**
 * POST /api/document-merge/jobs/[id]/cancel
 * Cancel job: item QUEUED/RETRY/PROCESSING → CANCELLED; job → CANCELLED.
 * Items COMPLETED giữ nguyên (individual PDFs đã lưu).
 */

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { mergeJobRecords, mergeJobs } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.execute");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id } = await context.params;
    const [job] = await db.select().from(mergeJobs).where(eq(mergeJobs.id, id)).limit(1);
    if (!job) return NextResponse.json({ error: "Merge job not found" }, { status: 404 });
    if (job.createdBy !== guard.session.username && guard.session.role !== "ADMIN") {
      return NextResponse.json({ error: "Không có quyền cancel job này." }, { status: 403 });
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) {
      return NextResponse.json({ error: `Job đã ở trạng thái ${job.status}.` }, { status: 400 });
    }

    const cancelled = await db
      .update(mergeJobRecords)
      .set({ status: "CANCELLED", leasedUntil: null, completedAt: new Date() })
      .where(
        and(
          eq(mergeJobRecords.mergeJobId, id),
          inArray(mergeJobRecords.status, ["QUEUED", "RETRY", "PROCESSING", "PENDING", "RUNNING"]),
        ),
      )
      .returning({ id: mergeJobRecords.id });

    await db
      .update(mergeJobs)
      .set({ status: "CANCELLED", completedAt: new Date(), errorSummary: "Job bị huỷ bởi người dùng.", updatedAt: new Date() })
      .where(eq(mergeJobs.id, id));

    await writeAudit(guard.session, "CANCEL_MERGE_JOB", "merge_jobs", { jobId: id, cancelledItems: cancelled.length });

    return NextResponse.json({ success: true, cancelledItems: cancelled.length, jobId: id });
  } catch (error) {
    console.error("[document-merge/jobs/[id]/cancel] error:", error);
    return NextResponse.json({ error: "Failed to cancel merge job" }, { status: 500 });
  }
}
