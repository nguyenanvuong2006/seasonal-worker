/**
 * Document Merge — job detail / progress (Phase 1).
 *
 * GET /api/document-merge/jobs/[id]
 *   Trả job + item-level progress (cho Progress UI Phase 7, poll 3–5s).
 *
 * POST /api/document-merge/jobs/[id]/retry  (Phase 7) — sẽ thêm ở route riêng.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { mergeJobRecords, mergeJobs } from "@/db/schema";
import { normalizeItemStatus } from "@/lib/document-merge/queue-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await context.params;

  try {
    const [job] = await db.select().from(mergeJobs).where(eq(mergeJobs.id, id)).limit(1);
    if (!job) {
      return NextResponse.json({ error: "Merge job not found" }, { status: 404 });
    }

    const items = await db
      .select({
        id: mergeJobRecords.id,
        sourceRecordId: mergeJobRecords.sourceRecordId,
        sortOrder: mergeJobRecords.sortOrder,
        status: mergeJobRecords.status,
        attemptCount: mergeJobRecords.attemptCount,
        pdfUrl: mergeJobRecords.pdfUrl,
        errorCode: mergeJobRecords.errorCode,
        errorMessage: mergeJobRecords.errorMessage,
      })
      .from(mergeJobRecords)
      .where(eq(mergeJobRecords.mergeJobId, id))
      .orderBy(mergeJobRecords.sortOrder);

    let queued = 0;
    let processing = 0;
    let completed = 0;
    let failed = 0;
    for (const item of items) {
      const s = normalizeItemStatus(item.status);
      if (s === "COMPLETED") completed += 1;
      else if (s === "FAILED") failed += 1;
      else if (s === "PROCESSING") processing += 1;
      else queued += 1;
    }

    return NextResponse.json({
      ...job,
      progress: {
        total: items.length,
        queued,
        processing,
        completed,
        failed,
      },
      items,
    });
  } catch (error) {
    console.error("[document-merge/jobs/[id]] GET error:", error);
    return NextResponse.json({ error: "Failed to fetch merge job" }, { status: 500 });
  }
}
