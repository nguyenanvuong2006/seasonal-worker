import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { workflowStages } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Đọc danh sách bước quy trình đang Active — dùng cho dropdown/màu trạng thái ở UI + Export.
 *  entityType mặc định "daily_application" để KHÔNG phá vỡ các nơi gọi cũ chưa truyền tham số. */
export async function GET(req: Request) {
  const entityType = new URL(req.url).searchParams.get("entityType") || "daily_application";
  const rows = await db
    .select()
    .from(workflowStages)
    .where(eq(workflowStages.entityType, entityType))
    .orderBy(asc(workflowStages.sortOrder));
  return NextResponse.json({ rows });
}
