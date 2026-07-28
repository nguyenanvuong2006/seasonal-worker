import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobErrors, importJobs } from "@/db/schema";
import { requireRoleAndPermission } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAGE_LABEL: Record<string, string> = {
  STAGING: "Đang nạp dữ liệu vào staging",
  VALIDATING: "Đang kiểm tra dữ liệu",
  MATCHING: "Đang đối chiếu DW Data",
  MERGING: "Đang cập nhật bảng chính",
  BUILDING_STATS: "Đang tổng hợp thống kê",
  DONE: "Hoàn tất",
  FAILED: "Lỗi",
};

/** Trạng thái 1 Job — trình duyệt CHỈ poll endpoint này để hiển thị tiến trình, không tham gia xử lý. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN"], "import.run");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, id));
  if (!job) return NextResponse.json({ error: "Không tìm thấy Job." }, { status: 404 });

  const elapsedSec = job.startedAt ? Math.max(1, (Date.now() - new Date(job.startedAt).getTime()) / 1000) : 0;
  const rowsPerSec = elapsedSec > 0 ? Math.round((job.processedRows / elapsedSec) * 10) / 10 : 0;
  const remaining = Math.max(0, job.totalRows - job.processedRows);
  const etaSec = rowsPerSec > 0 ? Math.round(remaining / rowsPerSec) : null;

  const errorSample = await db
    .select()
    .from(importJobErrors)
    .where(and(eq(importJobErrors.jobId, id), eq(importJobErrors.severity, "ERROR")))
    .orderBy(desc(importJobErrors.createdAt))
    .limit(50);
  const warningSample = await db
    .select()
    .from(importJobErrors)
    .where(and(eq(importJobErrors.jobId, id), eq(importJobErrors.severity, "WARNING")))
    .orderBy(desc(importJobErrors.createdAt))
    .limit(50);

  return NextResponse.json({
    job,
    stageLabel: STAGE_LABEL[job.currentStage] ?? job.currentStage,
    rowsPerSec,
    etaSec,
    errorSample,
    warningSample,
  });
}
