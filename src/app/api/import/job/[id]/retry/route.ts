import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { triggerWorker } from "@/lib/import-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retry/Resume THẬT — không chạy lại từ đầu. Dữ liệu đã staging + đã merge (cursor
 * `metadata.mergeCursor`) vẫn còn nguyên trong DB, chỉ đổi status để worker tiếp tục
 * đúng từ `current_stage` đã lưu. Dùng chung cho cả nút "Resume" (job PAUSED/dở dang do
 * mất kết nối) và "Retry" (job FAILED do lỗi tạm thời).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN"], "import.run");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, id));
  if (!job) return NextResponse.json({ error: "Không tìm thấy Job." }, { status: 404 });
  if (job.status === "DONE") return NextResponse.json({ error: "Job đã hoàn tất." }, { status: 400 });

  await db.update(importJobs).set({ status: "QUEUED", lastError: null, updatedAt: new Date() }).where(eq(importJobs.id, id));

  const baseUrl = new URL(req.url).origin;
  triggerWorker(id, job.resumeToken, baseUrl);

  await writeAudit(guard.session, "IMPORT_JOB_RESUMED", "import_jobs", { jobId: id, fromStage: job.currentStage }, "IMPORT");
  return NextResponse.json({ success: true });
}
