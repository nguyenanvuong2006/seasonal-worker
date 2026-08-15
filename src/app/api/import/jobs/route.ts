import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema";
import { requireRoleAndPermission } from "@/lib/auth";
import { findStalledJobs, triggerWorker } from "@/lib/import-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Job Queue / lịch sử — Completed/Running/Queued/Failed/Cancelled/Paused. */
export async function GET(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "import.run");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rows = await db.select().from(importJobs).orderBy(desc(importJobs.createdAt)).limit(30);

  // WATCHDOG CƠ HỘI (opportunistic) — không chờ Cron: ngay khi admin mở trang Import (endpoint
  // này được gọi để hiển thị Job Queue), phát hiện job RUNNING/QUEUED mất heartbeat > 90s (lượt
  // "chain" trước chết giữa chừng: deploy mới, cold start...) và tự kích hoạt lại chuỗi worker.
  // An toàn vì: (1) resumeToken khớp nên không tạo 2 chuỗi song song trên cùng job; (2) worker
  // tiếp tục đúng từ current_stage + mergeCursor đã lưu — không chạy lại, không tạo trùng.
  // Vercel Cron (1 lần/ngày trên Hobby) vẫn là lưới an toàn khi không ai mở trang.
  try {
    const stalled = await findStalledJobs();
    if (stalled.length > 0) {
      const baseUrl = new URL(req.url).origin;
      for (const job of stalled) triggerWorker(job.id, job.resumeToken, baseUrl);
      console.log(JSON.stringify({ event: "import_watchdog_opportunistic_resume", jobIds: stalled.map((j) => j.id) }));
    }
  } catch {
    /* watchdog cơ hội thất bại không được làm hỏng việc hiển thị danh sách job */
  }

  return NextResponse.json({ rows });
}
