import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobErrors, importJobs } from "@/db/schema";
import { requireRoleAndPermission } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download Log — toàn bộ dòng lỗi/cảnh báo của 1 Job dưới dạng CSV. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN"], "import.run");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, id));
  const errors = await db.select().from(importJobErrors).where(eq(importJobErrors.jobId, id)).orderBy(asc(importJobErrors.rowNumber));

  const lines = ["Mức độ,Dòng,Lý do,Dữ liệu gốc (JSON)"];
  for (const e of errors) {
    const cell = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    lines.push([e.severity, e.rowNumber, cell(e.reason), cell(JSON.stringify(e.originalData))].join(","));
  }
  const csv = "\uFEFF" + lines.join("\r\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="Import-Log-${job?.fileName ?? id}.csv"`,
    },
  });
}
