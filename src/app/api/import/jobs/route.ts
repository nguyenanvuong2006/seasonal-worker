import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema";
import { requireRoleAndPermission } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Job Queue / lịch sử — Completed/Running/Queued/Failed/Cancelled/Paused. */
export async function GET() {
  const guard = await requireRoleAndPermission(["ADMIN"], "import.run");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rows = await db.select().from(importJobs).orderBy(desc(importJobs.createdAt)).limit(30);
  return NextResponse.json({ rows });
}
