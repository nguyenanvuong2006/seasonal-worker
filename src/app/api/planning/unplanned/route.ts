import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getUnplannedSessions } from "@/lib/planning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lao động ĐANG LÀM nhưng chưa được phân bổ vào kế hoạch ACTIVE nào — dùng khi tạo kế hoạch mới. */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const departmentId = new URL(req.url).searchParams.get("departmentId") || undefined;
  const rows = await getUnplannedSessions(departmentId);
  return NextResponse.json({ rows });
}
