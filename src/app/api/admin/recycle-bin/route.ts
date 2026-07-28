import { NextResponse } from "next/server";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** SOFT DELETE (Giai đoạn 2 #7) — Recycle Bin: xem & khôi phục mọi hồ sơ đã "xoá" (deleted_at IS NOT NULL). */
export async function GET() {
  const guard = await requireRoleAndPermission(["ADMIN"], "recycle_bin.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const [deptRows, dwRows, appRows] = await Promise.all([
    db
      .select({
        id: departments.id,
        label: departments.deptName,
        sub: departments.groupName,
        deletedAt: departments.deletedAt,
        deletedBy: departments.deletedBy,
      })
      .from(departments)
      .where(isNotNull(departments.deletedAt))
      .orderBy(desc(departments.deletedAt)),
    db
      .select({
        id: dwData.id,
        label: dwData.fullName,
        sub: dwData.cccd,
        deletedAt: dwData.deletedAt,
        deletedBy: dwData.deletedBy,
      })
      .from(dwData)
      .where(isNotNull(dwData.deletedAt))
      .orderBy(desc(dwData.deletedAt)),
    db
      .select({
        id: dailyApplications.id,
        label: dailyApplications.fullName,
        sub: dailyApplications.cccd,
        deletedAt: dailyApplications.deletedAt,
        deletedBy: dailyApplications.deletedBy,
      })
      .from(dailyApplications)
      .where(isNotNull(dailyApplications.deletedAt))
      .orderBy(desc(dailyApplications.deletedAt)),
  ]);

  return NextResponse.json({ departments: deptRows, dwData: dwRows, dailyApplications: appRows });
}

const TABLES = { departments, dw_data: dwData, daily_applications: dailyApplications } as const;
type TableKey = keyof typeof TABLES;

/** Khôi phục 1 hồ sơ đã xoá mềm. */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "recycle_bin.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { table, id } = (await req.json()) as { table?: TableKey; id?: string };
  if (!table || !(table in TABLES) || !id) {
    return NextResponse.json({ error: "Thiếu bảng hoặc ID." }, { status: 400 });
  }

  const t = TABLES[table];
  await db.update(t).set({ deletedAt: null, deletedBy: null }).where(eq(t.id, id));
  await writeAudit(guard.session, "RESTORE_FROM_RECYCLE_BIN", table, { id });
  return NextResponse.json({ success: true });
}

/** Xoá vĩnh viễn (không thể hoàn tác) — chỉ áp dụng cho hồ sơ đã ở trong Recycle Bin. */
export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "recycle_bin.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const table = url.searchParams.get("table") as TableKey | null;
  const id = url.searchParams.get("id");
  if (!table || !(table in TABLES) || !id) {
    return NextResponse.json({ error: "Thiếu bảng hoặc ID." }, { status: 400 });
  }

  const t = TABLES[table];
  await db.delete(t).where(and(eq(t.id, id), isNotNull(t.deletedAt)));
  await writeAudit(guard.session, "PURGE_RECYCLE_BIN", table, { id });
  return NextResponse.json({ success: true });
}
