/**
 * POST /api/archive/runs — Archive Agent mở phiên chạy (RUNNING, count=0).
 * POST /api/archive/runs/complete — đóng phiên (COMPLETED/PARTIAL/FAILED + counts + manifest_path).
 *
 * Auth: Bearer ARCHIVE_API_KEY hoặc session ADMIN.
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
    const body = (await request.json().catch(() => ({}))) as { runType?: string };
    const [run] = await db
      .insert(archiveRuns)
      .values({
        runType: body.runType === "DAILY" || body.runType === "WEEKLY" ? body.runType : "MANUAL",
        status: "RUNNING",
      })
      .returning();

    return NextResponse.json({ runId: run.id }, { status: 201 });
  } catch (error) {
    console.error("[archive/runs] POST error:", error);
    return NextResponse.json({ error: "Failed to create archive run" }, { status: 500 });
  }
}
