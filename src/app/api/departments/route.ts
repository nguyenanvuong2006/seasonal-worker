import { NextResponse } from "next/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sheet "Department" — Dept. + Group, tự động vào dropdown Daily Application */
export async function GET() {
  const today = todayStr();
  const rows = await db
    .select({
      id: departments.id,
      stt: departments.stt,
      location: departments.location,
      division: departments.division,
      deptName: departments.deptName,
      section: departments.section,
      groupName: departments.groupName,
      vnName: departments.vnName,
      supervisor: departments.supervisor,
      supervisorPhone: departments.supervisorPhone,
      sheetLink: departments.sheetLink,
      dailyQuota: departments.dailyQuota,
      isActive: departments.isActive,
      assignedToday: sql<number>`(
        select count(*)::int from daily_applications d
        where d.dept_id = ${departments.id} and d.reg_date = ${today} and d.status = 'APPROVED' and d.deleted_at is null
      )`,
      totalAssigned: sql<number>`(
        select count(*)::int from daily_applications d where d.dept_id = ${departments.id} and d.deleted_at is null
      )`,
    })
    .from(departments)
    .where(isNull(departments.deletedAt))
    .orderBy(asc(departments.deptName), asc(departments.groupName));

  // Chuẩn hoá tên người phụ trách bộ phận trước khi trả về UI.
  return NextResponse.json({
    rows: rows.map((r) => ({ ...r, supervisor: normalizePersonName(r.supervisor) })),
  });
}

export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "departments.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const body = await req.json();
    const deptName = String(body.deptName || "").trim();
    if (!deptName) return NextResponse.json({ error: "Thiếu tên bộ phận (Dept.)." }, { status: 400 });

    const [max] = await db.select({ m: sql<number>`coalesce(max(stt),0)::int` }).from(departments);

    const [created] = await db
      .insert(departments)
      .values({
        stt: (max?.m ?? 0) + 1,
        location: body.location || "",
        division: body.division || "",
        deptName,
        section: body.section || "",
        groupName: String(body.groupName || "").trim(),
        vnName: body.vnName || null,
        supervisor: normalizePersonName(body.supervisor) || null,
        supervisorPhone: body.supervisorPhone || null,
        sheetLink: body.sheetLink || null,
        dailyQuota: Number(body.dailyQuota) || 0,
      })
      .returning();

    await writeAudit(guard.session, "CREATE_DEPARTMENT", "departments", { id: created.id, deptName });
    return NextResponse.json({ success: true, row: created });
  } catch (error) {
    return NextResponse.json(
      { error: "Bộ phận + Nhóm này đã tồn tại: " + (error as Error).message },
      { status: 400 },
    );
  }
}

const EDITABLE = ["location", "division", "deptName", "section", "groupName", "vnName", "supervisor", "supervisorPhone", "sheetLink", "dailyQuota", "isActive"] as const;

export async function PATCH(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "departments.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const [before] = await db.select().from(departments).where(eq(departments.id, body.id));

  const patch: Record<string, unknown> = {};
  for (const k of ["location", "division", "deptName", "section", "groupName", "vnName", "supervisor", "supervisorPhone", "sheetLink"]) {
    if (k in body) patch[k] = body[k] ?? null;
  }
  // Chuẩn hoá tên người phụ trách bộ phận trước khi lưu.
  if (typeof patch.supervisor === "string") patch.supervisor = normalizePersonName(patch.supervisor) || null;
  if ("dailyQuota" in body) patch.dailyQuota = Number(body.dailyQuota) || 0;
  if ("isActive" in body) patch.isActive = Boolean(body.isActive);

  const [row] = await db.update(departments).set(patch).where(eq(departments.id, body.id)).returning();

  // VERSIONING: lưu trạng thái trước/sau để có thể xem lịch sử & khôi phục (mục /admin/audit).
  const beforeSnapshot = before ? Object.fromEntries(EDITABLE.map((k) => [k, (before as Record<string, unknown>)[k]])) : null;
  await writeAudit(guard.session, "UPDATE_DEPARTMENT", "departments", {
    id: body.id,
    before: beforeSnapshot,
    after: patch,
  });
  return NextResponse.json({ success: true, row });
}

/** Xoá mềm (soft delete) — hồ sơ được ẩn khỏi danh sách nhưng vẫn còn trong database, khôi phục được tại /admin/recycle-bin. */
export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "departments.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  await db
    .update(departments)
    .set({ deletedAt: new Date(), deletedBy: guard.session.username })
    .where(and(eq(departments.id, id), isNull(departments.deletedAt)));

  await writeAudit(guard.session, "SOFT_DELETE_DEPARTMENT", "departments", { id });
  return NextResponse.json({ success: true });
}
