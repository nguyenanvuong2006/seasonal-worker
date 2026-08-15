import { NextResponse } from "next/server";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { getUserScope, getSession, hasPermission, requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sheet "Department" — Dept. + Group.
 * scope=self: chỉ trả về bộ phận thuộc Data Scope của người đang đăng nhập (cổng
 * "Bộ phận của tôi" — bộ lọc không hiện bộ phận chưa được phân quyền).
 * scope=all: bỏ qua Data Scope, trả về toàn bộ bộ phận đang hoạt động (dropdown
 * "Bộ phận mới" khi Báo thuyên chuyển — không giới hạn theo phân quyền).
 * (mặc định): giữ nguyên hành vi cũ cho Admin/HR — toàn bộ danh sách.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
  const url = new URL(req.url);
  const scopeParam = url.searchParams.get("scope");

  // Destination lookup is a deliberate exception: a source-scoped user may request transfer
  // to another department. Return only non-sensitive canonical destination display fields.
  if (scopeParam === "all") {
    if (!(await hasPermission(session.role, "workforce_movements.create"))) {
      return NextResponse.json({ error: "Không có quyền tạo yêu cầu thuyên chuyển." }, { status: 403 });
    }
    const rows = await db
      .select({ id: departments.id, deptName: departments.deptName, groupName: departments.groupName })
      .from(departments)
      .where(and(isNull(departments.deletedAt), eq(departments.isActive, true)))
      .orderBy(asc(departments.deptName), asc(departments.groupName));
    return NextResponse.json({ rows, destinationLookup: true });
  }

  const scope = await getUserScope(session);
  if (scope !== null && scope.length === 0) return NextResponse.json({ rows: [], scoped: true });
  const today = todayStr();
  const filters = [isNull(departments.deletedAt)];
  if (scope !== null) filters.push(inArray(departments.id, scope));
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
    .where(and(...filters))
    .orderBy(asc(departments.deptName), asc(departments.groupName));

  return NextResponse.json({
    rows: rows.map((r) => ({ ...r, supervisor: normalizePersonName(r.supervisor) })),
    scoped: scope !== null,
    selfScope: scopeParam === "self",
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
