import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { requireRoleAndPermission } from "@/lib/auth";
import { processNotificationQueue } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "notifications.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rows = await db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(200);
  return NextResponse.json({ rows });
}

/** Xử lý thủ công hàng đợi (thay vì chờ Scheduler/Cron). */
export async function POST() {
  const guard = await requireRoleAndPermission(["ADMIN"], "notifications.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const result = await processNotificationQueue(200);
  return NextResponse.json({ success: true, ...result });
}
