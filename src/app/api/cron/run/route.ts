import { NextResponse } from "next/server";
import { runDueJobs } from "@/lib/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Endpoint được Vercel Cron gọi (xem vercel.json) — hoặc, nếu gói Vercel đang
 * dùng không có Cron, đặt 1 job gọi URL này định kỳ tại dịch vụ ngoài miễn
 * phí (vd cron-job.org). Bảo vệ bằng CRON_SECRET (biến môi trường trên
 * Vercel) — không có secret đúng thì từ chối, tránh ai cũng gọi được.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (expected && auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Không có quyền." }, { status: 401 });
  }
  const results = await runDueJobs();
  return NextResponse.json({ ok: true, results });
}
