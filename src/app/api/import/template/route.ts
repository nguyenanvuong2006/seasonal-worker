import { NextResponse } from "next/server";
import { requireRoleAndPermission } from "@/lib/auth";
import { getImportTemplate } from "@/lib/import-template";
import type { Group } from "@/lib/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Metadata cho bảng template dán trực tiếp trên trang Import. */
export async function GET(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "import.run");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const jobType = (new URL(req.url).searchParams.get("jobType") || "daily_application") as Group;
  if (!["department", "dw_data", "daily_application"].includes(jobType)) {
    return NextResponse.json({ error: "Loại dữ liệu không hợp lệ." }, { status: 400 });
  }

  const columns = await getImportTemplate(jobType);
  return NextResponse.json({ columns });
}
