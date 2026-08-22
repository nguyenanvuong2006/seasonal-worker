import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { workflowStages } from "@/db/schema";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Đọc danh sách bước quy trình đang Active — dùng cho dropdown/màu trạng thái ở UI + Export.
 *  entityType mặc định "daily_application" để KHÔNG phá vỡ các nơi gọi cũ chưa truyền tham số.
 *  Production Recovery audit — route này TRƯỚC ĐÂY không có auth check nào (khác mọi route
 *  nội bộ khác trong app); cả 2 nơi gọi (registrations-grid, admin/workforce-movements) đều là
 *  trang nội bộ, không có luồng public nào cần route này — thêm session check tối thiểu. */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
  const entityType = new URL(req.url).searchParams.get("entityType") || "daily_application";
  const rows = await db
    .select()
    .from(workflowStages)
    .where(eq(workflowStages.entityType, entityType))
    .orderBy(asc(workflowStages.sortOrder));
  return NextResponse.json({ rows });
}
