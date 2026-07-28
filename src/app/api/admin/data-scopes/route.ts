import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments, userDepartmentScopes, users } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ma trận User ↔ Department (Data Scope) — chỉ áp dụng cho Role DEPT_MANAGER. */
export async function GET() {
  const guard = await requireRoleAndPermission(["ADMIN"], "data_scopes.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const [scopeUsers, allDepts, scopes] = await Promise.all([
    db.select({ id: users.id, username: users.username, fullName: users.fullName, role: users.role }).from(users).where(eq(users.role, "DEPT_MANAGER")),
    db.select({ id: departments.id, deptName: departments.deptName, groupName: departments.groupName }).from(departments).where(eq(departments.isActive, true)),
    db.select().from(userDepartmentScopes),
  ]);

  return NextResponse.json({ users: scopeUsers, departments: allDepts, scopes });
}

/** Gán 1 department cho 1 user. */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "data_scopes.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as { userId?: string; departmentId?: string };
  if (!body.userId || !body.departmentId) return NextResponse.json({ error: "Thiếu userId hoặc departmentId." }, { status: 400 });

  await db.insert(userDepartmentScopes).values({ userId: body.userId, departmentId: body.departmentId }).onConflictDoNothing();
  await writeAudit(guard.session, "ADD_DATA_SCOPE", "user_department_scopes", body);
  return NextResponse.json({ success: true });
}

/** Bỏ gán 1 department khỏi 1 user. */
export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "data_scopes.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  const departmentId = url.searchParams.get("departmentId");
  if (!userId || !departmentId) return NextResponse.json({ error: "Thiếu userId hoặc departmentId." }, { status: 400 });

  await db.delete(userDepartmentScopes).where(and(eq(userDepartmentScopes.userId, userId), eq(userDepartmentScopes.departmentId, departmentId)));
  await writeAudit(guard.session, "REMOVE_DATA_SCOPE", "user_department_scopes", { userId, departmentId });
  return NextResponse.json({ success: true });
}
