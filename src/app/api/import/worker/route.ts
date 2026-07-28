import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema";
import { runNextStep, triggerWorker } from "@/lib/import-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * IMPORT ENGINE v3 — "Worker" nội bộ, KHÔNG gọi trực tiếp từ trình duyệt. Mỗi lần gọi xử lý
 * ĐÚNG 1 bước/1 lô (vài giây), rồi tự kích hoạt lượt kế tiếp bằng `after()` — chuỗi này chạy
 * hoàn toàn phía server, độc lập với trình duyệt (đóng tab không dừng Job) và độc lập với
 * thời gian sống của bất kỳ 1 request cụ thể nào (không request nào giữ kết nối quá vài giây).
 *
 * `resumeToken` xác thực lượt gọi đúng của job (tránh 2 chuỗi worker chạy song song trên
 * cùng 1 job nếu bị gọi trùng do watchdog + chain tự nhiên cùng lúc).
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { jobId?: string; resumeToken?: string };
  if (!body.jobId || !body.resumeToken) return NextResponse.json({ error: "Thiếu jobId/resumeToken." }, { status: 400 });

  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, body.jobId));
  if (!job) return NextResponse.json({ error: "Job không tồn tại." }, { status: 404 });
  if (job.resumeToken !== body.resumeToken) {
    return NextResponse.json({ error: "resumeToken không khớp — bỏ qua (có thể là lượt gọi trùng)." }, { status: 409 });
  }
  if (job.status === "CANCELLED" || job.status === "DONE" || job.status === "PAUSED") {
    return NextResponse.json({ ok: true, stopped: job.status });
  }

  const result = await runNextStep(body.jobId);

  if (!result.done) {
    const baseUrl = new URL(req.url).origin;
    triggerWorker(body.jobId, job.resumeToken, baseUrl);
  }

  return NextResponse.json({ ok: true, stage: result.stage, done: result.done });
}
