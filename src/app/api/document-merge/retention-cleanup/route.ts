/**
 * POST /api/document-merge/retention-cleanup
 * Chạy retention cleanup thủ công (hoặc qua cron):
 *   - Xoá PDF cá nhân hết hạn ĐÃ VERIFIED (giữ nếu chưa VERIFIED).
 *   - Xoá batch outputs (PDF tổng + ZIP) hết TTL.
 *
 * Auth: Bearer CRON_SECRET (cron Vercel) hoặc session ADMIN.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { requirePermission } from "@/lib/auth";
import { runRetentionCleanup } from "@/lib/document-merge/retention-cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Cron path: Bearer CRON_SECRET
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const a = Buffer.from(cronSecret);
    const b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      const result = await runRetentionCleanup();
      return NextResponse.json({ success: true, ...result });
    }
  }

  // Admin path
  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const result = await runRetentionCleanup();
  return NextResponse.json({ success: true, ...result });
}
