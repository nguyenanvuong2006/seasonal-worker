import { NextResponse } from "next/server";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, users } from "@/db/schema";
import { hashPassword, requirePermission, writeAudit } from "@/lib/auth";
import { isKnownRoleKey, listRoles } from "@/lib/rbac";
import {
  buildPatch,
  changedFields,
  lastActiveAdminError,
  selectAuditAction,
  selfProtectionError,
  shouldBumpSessionVersion,
  validatePassword,
  type ChangeIntent,
  type UserSnapshot,
} from "@/lib/user-management";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// P1-5 (Production Hardening Audit) — chuẩn hoá 1 policy mật khẩu duy nhất cho create/reset,
// khớp với mức tối thiểu đã dùng ở bootstrap INITIAL_ADMIN_PASSWORD (trước đây route này cho
// phép 6 ký tự, thấp hơn bootstrap — không nhất quán). Giá trị giờ nằm ở user-management.ts.

function toSnapshot(row: typeof users.$inferSelect): UserSnapshot {
  return {
    id: row.id,
    username: row.username,
    fullName: row.fullName,
    role: row.role,
    deptId: row.deptId,
    isActive: row.isActive,
  };
}

export async function GET() {
  const guard = await requirePermission(["ADMIN"], "users.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      role: users.role,
      deptId: users.deptId,
      deptName: departments.deptName,
      groupName: departments.groupName,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(departments, eq(users.deptId, departments.id))
    .orderBy(asc(users.username));

  // Trả kèm id của Admin đang đăng nhập để frontend disable/hide các action self-protection
  // (lớp bảo vệ CHÍNH vẫn nằm ở backend) + danh mục vai trò cho dropdown (Dynamic RBAC V2).
  const roleCatalog = await listRoles();
  return NextResponse.json({
    rows,
    currentUserId: guard.session.id,
    roles: roleCatalog.map((r) => ({ key: r.key, name: r.name, isActive: r.isActive, memberCount: r.memberCount })),
  });
}

export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN"], "users.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const body = await req.json();
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!/^[a-z0-9_.]{3,32}$/.test(username)) {
      return NextResponse.json(
        { error: "Tên đăng nhập 3-32 ký tự, chỉ chữ thường/số/dấu chấm/gạch dưới." },
        { status: 400 },
      );
    }
    const pwError = validatePassword(password);
    if (pwError) return NextResponse.json({ error: pwError }, { status: 400 });
    if (!(await isKnownRoleKey(String(body.role)))) {
      return NextResponse.json({ error: "Vai trò không hợp lệ." }, { status: 400 });
    }

    const [row] = await db
      .insert(users)
      .values({
        username,
        passwordHash: hashPassword(password),
        fullName: String(body.fullName || username),
        role: body.role,
        deptId: body.role === "DEPT_MANAGER" ? body.deptId || null : null,
      })
      .returning({ id: users.id, username: users.username });

    await writeAudit(guard.session, "CREATE_USER", "users", { id: row.id, username });
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return NextResponse.json(
      { error: "Tên đăng nhập đã tồn tại: " + (error as Error).message },
      { status: 400 },
    );
  }
}

export async function PATCH(req: Request) {
  const guard = await requirePermission(["ADMIN"], "users.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const [target] = await db.select().from(users).where(eq(users.id, String(body.id))).limit(1);
  if (!target) return NextResponse.json({ error: "Không tìm thấy người dùng." }, { status: 404 });

  const change: ChangeIntent = {};
  if ("fullName" in body) change.fullName = String(body.fullName ?? "");
  if ("role" in body) change.role = String(body.role ?? "");
  if ("deptId" in body) change.deptId = body.deptId ? String(body.deptId) : null;
  if ("isActive" in body) change.isActive = Boolean(body.isActive);
  if ("password" in body && body.password) change.password = String(body.password);

  if (change.role !== undefined && !(await isKnownRoleKey(change.role))) {
    return NextResponse.json({ error: "Vai trò không hợp lệ." }, { status: 400 });
  }

  const snapshot = toSnapshot(target);

  // 1) Bảo vệ chính Admin đang đăng nhập (tự khoá / tự xoá / tự hạ quyền).
  const selfError = selfProtectionError(guard.session.id, snapshot, change);
  if (selfError) return NextResponse.json({ error: selfError }, { status: 400 });

  // 2) Bảo vệ Admin hoạt động cuối cùng (khoá / xoá / hạ quyền ADMIN).
  const allUsers = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users);
  const lastAdminError = lastActiveAdminError(
    allUsers,
    { id: snapshot.id, role: snapshot.role, isActive: snapshot.isActive },
    change,
  );
  if (lastAdminError) return NextResponse.json({ error: lastAdminError }, { status: 400 });

  // 3) Kiểm tra policy mật khẩu nếu có đổi mật khẩu.
  if (change.password !== undefined) {
    const pwError = validatePassword(change.password);
    if (pwError) return NextResponse.json({ error: pwError }, { status: 400 });
  }

  // change.role ĐÃ được kiểm tra ở trên (isKnownRoleKey async — gồm catalog + bảng roles).
  // buildPatch giữ chữ ký đồng bộ nên truyền validator "luôn hợp lệ" cho đúng giá trị đã kiểm tra.
  const { patch, password } = buildPatch(change, () => true);
  if (password) patch.passwordHash = hashPassword(password);

  // 4) Đổi role/khoá tài khoản/đổi mật khẩu -> tăng sessionVersion để mọi JWT cũ hết hiệu lực ngay.
  if (shouldBumpSessionVersion(snapshot, change)) {
    patch.sessionVersion = sql`${users.sessionVersion} + 1`;
  }

  const [row] = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, snapshot.id))
    .returning({ id: users.id, username: users.username });

  const action = selectAuditAction(snapshot, change);
  const fields = changedFields(snapshot, change);

  // Audit details: target id/username + field thay đổi; KHÔNG BAO GIỜ log giá trị mật khẩu.
  await writeAudit(guard.session, action, "users", {
    id: row.id,
    username: row.username,
    changed: fields,
    ...(action === "UPDATE_USER"
      ? {
          before: { fullName: snapshot.fullName, role: snapshot.role, deptId: snapshot.deptId },
          after: {
            fullName: "fullName" in patch ? patch.fullName : snapshot.fullName,
            role: "role" in patch ? patch.role : snapshot.role,
            deptId: "deptId" in patch ? patch.deptId : snapshot.deptId,
          },
        }
      : {}),
    ...(action === "DEACTIVATE_USER" ? { isActive: false } : {}),
    ...(action === "ACTIVATE_USER" ? { isActive: true } : {}),
  });

  return NextResponse.json({ success: true, row });
}

/**
 * DELETE = SOFT DELETE (an toàn), KHÔNG xoá vật lý.
 *
 * AUDIT FK/REFERENCE CỦA `users` (đã rà soát toàn schema):
 *  - `audit_logs.user_id`       — uuid KHÔNG có FK, lưu kèm `username` (denormalized).
 *  - `user_department_scopes.user_id` — uuid KHÔNG có FK.
 *  - Các cột `*_by` (departments/dw_data/daily_applications/worker_profiles.deleted_by,
 *    workforce_movements.requested_by, import_*.started_by/created_by, planning_periods.created_by)
 *    lưu `username` dạng text, không ràng buộc.
 * => Không có FK cứng nào trỏ tới users.id, NHƯNG xoá vật lý vẫn làm mất khả năng liên kết
 *    `audit_logs.user_id` về đúng người thao tác (lịch sử "Ai đã làm" bị đứt) và để lại scope
 *    mồ côi. Đúng theo ràng buộc "Audit Log không được mất lịch sử người đã thao tác", chọn
 *    SAFE DEACTIVATION: set isActive=false + tăng sessionVersion (đăng xuất mọi phiên) và ghi
 *    snapshot đầy đủ vào audit để có thể khôi phục. Tài khoản vẫn nằm trong bảng users (hiển
 *    thị "Đã khoá"), có thể "Kích hoạt lại" bất cứ lúc nào.
 */
export async function DELETE(req: Request) {
  const guard = await requirePermission(["ADMIN"], "users.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) return NextResponse.json({ error: "Không tìm thấy người dùng." }, { status: 404 });

  const snapshot = toSnapshot(target);
  const change: ChangeIntent = { deleting: true };

  const selfError = selfProtectionError(guard.session.id, snapshot, change);
  if (selfError) return NextResponse.json({ error: selfError }, { status: 400 });

  const allUsers = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users);
  const lastAdminError = lastActiveAdminError(
    allUsers,
    { id: snapshot.id, role: snapshot.role, isActive: snapshot.isActive },
    change,
  );
  if (lastAdminError) return NextResponse.json({ error: lastAdminError }, { status: 400 });

  // SOFT DELETE — không db.delete(); chỉ vô hiệu hoá + đăng xuất mọi phiên cũ.
  await db
    .update(users)
    .set({ isActive: false, sessionVersion: sql`${users.sessionVersion} + 1` })
    .where(eq(users.id, snapshot.id));

  await writeAudit(guard.session, "DELETE_USER", "users", {
    id: snapshot.id,
    username: snapshot.username,
    softDelete: true,
    before: {
      fullName: snapshot.fullName,
      role: snapshot.role,
      deptId: snapshot.deptId,
      isActive: snapshot.isActive,
    },
  });

  return NextResponse.json({ success: true });
}
