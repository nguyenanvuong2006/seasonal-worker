/**
 * POST /api/archive/runs/complete — đóng phiên archive run.
 * Body: { runId, status: COMPLETED|PARTIAL|FAILED, downloadedCount, verifiedCount,
 *         failedCount, manifestPath, errorSummary? }
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { archiveRuns } from "@/db/schema";
import { authenticateArchiveRequest } from "@/lib/document-merge/archive-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await authenticateArchiveRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = (await request.json()) as {
      runId?: string;
      status?: string;
      downloadedCount?: number;
      verifiedCount?: number;
      failedCount?: number;
      manifestPath?: string | null;
      errorSummary?: string | null;
    };
    if (!body.runId) {
      return NextResponse.json({ error: "Cần runId." }, { status: 400 });
    }
    const status = ["COMPLETED", "PARTIAL", "FAILED"].includes(body.status ?? "")
      ? body.status!
      : "COMPLETED";

    const [run] = await db
      .update(archiveRuns)
      .set({
        status,
        completedAt: new Date(),
        downloadedCount: body.downloadedCount ?? 0,
        verifiedCount: body.verifiedCount ?? 0,
        failedCount: body.failedCount ?? 0,
        manifestPath: body.manifestPath ?? null,
        errorSummary: body.errorSummary ?? null,
      })
      .where(eq(archiveRuns.id, body.runId))
      .returning();

    return NextResponse.json({ success: true, runId: run.id, status: run.status });
  } catch (error) {
    console.error("[archive/runs/complete] POST error:", error);
    return NextResponse.json({ error: "Failed to complete archive run" }, { status: 500 });
  }
}
