import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { formQuestions } from "@/db/schema";
import { requireRoleAndPermission } from "@/lib/auth";
import { getFieldDefinitions, templateColumns, type Group } from "@/lib/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LABEL: Record<Group, string> = {
  department: "Department",
  dw_data: "DW-Data",
  daily_application: "Daily-Application",
};

/** Sinh file mẫu CSV (header) trực tiếp từ field_definitions — không lưu file tĩnh. */
export async function GET(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "field_definitions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const group = (new URL(req.url).searchParams.get("group") || "daily_application") as Group;
  if (!["department", "dw_data", "daily_application"].includes(group)) {
    return NextResponse.json({ error: "group không hợp lệ." }, { status: 400 });
  }

  const defs = await getFieldDefinitions(group);
  const headers = templateColumns(defs);

  // Daily Application: các câu hỏi động đang bật cũng phải tự có cột trong file mẫu.
  if (group === "daily_application") {
    const questions = await db
      .select()
      .from(formQuestions)
      .where(eq(formQuestions.isActive, true))
      .orderBy(asc(formQuestions.sortOrder));
    for (const q of questions) headers.push(q.questionText);
  }

  const csv = "\uFEFF" + headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(",") + "\r\n";

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="Template-${LABEL[group]}.csv"`,
    },
  });
}
