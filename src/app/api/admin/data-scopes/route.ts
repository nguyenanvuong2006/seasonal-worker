import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { departments, userDepartmentScopes, users } from "@/db/schema";
import { requirePermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Danh sách User (DEPT_MANAGER) và bộ phận với đầy đủ cơ cấu tổ chức (Location -> Division -> Department -> Section -> Group). */
export async function GET() {
  const guard = await requirePermission(["ADMIN"], "data_scope.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const [scopeUsers, allDepts, scopes] = await Promise.all([
    db
      .select({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        role: users.role,
      })
      .from(users)
      .where(ne(users.role, "ADMIN")),
    db
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
      })
      .from(departments)
      .where(and(eq(departments.isActive, true), isNull(departments.deletedAt))),
    db.select().from(userDepartmentScopes),
  ]);

  return NextResponse.json({ users: scopeUsers, departments: allDepts, scopes });
}

/** Cập nhật hàng loạt danh sách bộ phận cho 1 user (Transactional replacement). */
export async function PUT(req: Request) {
  const guard = await requirePermission(["ADMIN"], "data_scope.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as { userId?: string; departmentIds?: string[] };
  const userId = body.userId?.trim();
  if (!userId || !Array.isArray(body.departmentIds)) {
    return NextResponse.json({ error: "Thiếu userId hoặc danh sách departmentIds." }, { status: 400 });
  }

  // Xác thực user tồn tại
  const [targetUser] = await db.select().from(users).where(eq(users.id, userId));
  if (!targetUser) {
    return NextResponse.json({ error: "Không tìm thấy người dùng." }, { status: 404 });
  }

  // Lọc IDs hợp lệ & loại bỏ trùng lặp
  const uniqueDeptIds = Array.from(new Set(body.departmentIds.filter((id) => typeof id === "string" && id.trim().length > 0)));

  if (uniqueDeptIds.length > 0) {
    const validDepts = await db
      .select({ id: departments.id })
      .from(departments)
      .where(and(inArray(departments.id, uniqueDeptIds), eq(departments.isActive, true), isNull(departments.deletedAt)));
    const validDeptSet = new Set(validDepts.map((d) => d.id));
    const invalidCount = uniqueDeptIds.filter((id) => !validDeptSet.has(id)).length;
    if (invalidCount > 0) {
      return NextResponse.json({ error: "Một số bộ phận không tồn tại hoặc đã bị vô hiệu hoá." }, { status: 400 });
    }
  }

  await db.transaction(async (tx) => {
    // Xoá các scope cũ của user này
    await tx.delete(userDepartmentScopes).where(eq(userDepartmentScopes.userId, userId));

    // Thêm các scope mới
    if (uniqueDeptIds.length > 0) {
      await tx.insert(userDepartmentScopes).values(
        uniqueDeptIds.map((deptId) => ({
          userId,
          departmentId: deptId,
        })),
      );
    }
  });

  await writeAudit(guard.session, "BATCH_UPDATE_DATA_SCOPE", "user_department_scopes", {
    userId,
    username: targetUser.username,
    departmentCount: uniqueDeptIds.length,
    departmentIds: uniqueDeptIds,
  });

  return NextResponse.json({ success: true, count: uniqueDeptIds.length });
}

/** Gán 1 department cho 1 user (Single). */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN"], "data_scope.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as { userId?: string; departmentId?: string };
  if (!body.userId || !body.departmentId) return NextResponse.json({ error: "Thiếu userId hoặc departmentId." }, { status: 400 });

  await db.insert(userDepartmentScopes).values({ userId: body.userId, departmentId: body.departmentId }).onConflictDoNothing();
  await writeAudit(guard.session, "ADD_DATA_SCOPE", "user_department_scopes", body);
  return NextResponse.json({ success: true });
}

/** Bỏ gán 1 department khỏi 1 user (Single). */
export async function DELETE(req: Request) {
  const guard = await requirePermission(["ADMIN"], "data_scope.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  const departmentId = url.searchParams.get("departmentId");
  if (!userId || !departmentId) return NextResponse.json({ error: "Thiếu userId hoặc departmentId." }, { status: 400 });

  await db.delete(userDepartmentScopes).where(and(eq(userDepartmentScopes.userId, userId), eq(userDepartmentScopes.departmentId, departmentId)));
  await writeAudit(guard.session, "REMOVE_DATA_SCOPE", "user_department_scopes", { userId, departmentId });
  return NextResponse.json({ success: true });
}
