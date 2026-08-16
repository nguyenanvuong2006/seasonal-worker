import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { listSessionsForAllocation } from "@/lib/workforce-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Danh sách Employment Session ACTIVE để Recruiter phân bổ / tái phân bổ (mục 12). */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "workforce_request.allocate");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const search = url.searchParams.get("search") ?? undefined;

  const rows = await listSessionsForAllocation(search);
  return NextResponse.json({ rows });
}
