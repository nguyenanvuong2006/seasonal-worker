import { NextResponse } from "next/server";
import { requireRoleAndPermission } from "@/lib/auth";
import { getImportTemplate } from "@/lib/import-template";
import type { Group } from "@/lib/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LABEL: Record<Group, string> = {
  department: "Department",
  dw_data: "DW-Data",
  daily_application: "Daily-Application",
};

/** Sinh file CSV mẫu từ cùng metadata đang dựng bảng dán trực tiếp. */
export async function GET(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "field_definitions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const group = (new URL(req.url).searchParams.get("group") || "daily_application") as Group;
  if (!["department", "dw_data", "daily_application"].includes(group)) {
    return NextResponse.json({ error: "group không hợp lệ." }, { status: 400 });
  }

  const columns = await getImportTemplate(group);
  const headers = columns.filter((column) => column.defaultVisible).map((column) => column.header);
  const csv = "\uFEFF" + headers.map((header) => `"${header.replace(/"/g, '""')}"`).join(",") + "\r\n";

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="Template-${LABEL[group]}.csv"`,
    },
  });
}
