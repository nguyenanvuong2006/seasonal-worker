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
 *
 * FAIL-CLOSED ở production: nếu CRON_SECRET chưa được cấu hình, endpoint từ chối MỌI request
 * (kể cả không kèm token) thay vì chạy công khai không cần xác thực — tránh việc quên set
 * biến môi trường vô tình để lộ 1 endpoint có thể trigger job nghiệp vụ (gửi thông báo, hết
 * hạn kế hoạch...) cho bất kỳ ai gọi được URL. Ngoài production (local dev), nếu CRON_SECRET
 * chưa set thì vẫn cho chạy để tiện phát triển — không hardcode secret fallback nào.
 */
export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (!expected) {
    if (isProduction) {
      console.error("[cron] CRON_SECRET chưa được cấu hình trên production — từ chối yêu cầu tới /api/cron/run.");
      return NextResponse.json({ error: "Không có quyền." }, { status: 401 });
    }
  } else {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: "Không có quyền." }, { status: 401 });
    }
  }

  const results = await runDueJobs();
  return NextResponse.json({ ok: true, results });
}
