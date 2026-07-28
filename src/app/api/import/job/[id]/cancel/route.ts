import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Huỷ Job — worker sẽ tự dừng ở lượt "chain" kế tiếp khi thấy status=CANCELLED. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN"], "import.run");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  await db.update(importJobs).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(importJobs.id, id));
  await writeAudit(guard.session, "IMPORT_JOB_CANCELLED", "import_jobs", { jobId: id }, "IMPORT");
  return NextResponse.json({ success: true });
}
