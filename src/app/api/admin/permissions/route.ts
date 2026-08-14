import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { permissions, rolePermissions, roles } from "@/db/schema";
import { invalidatePermissionCache, requirePermission, writeAudit } from "@/lib/auth";
import { getCatalogPermission, PERMISSION_CATALOG, PERMISSION_GROUPS } from "@/lib/rbac-catalog";
import { bumpSessionVersionForRole, listPermissions, listRoles, upsertRolePermission } from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DYNAMIC RBAC V2 — /api/admin/permissions
 * GET  : catalog đầy đủ (roles + permissions + groups + ma trận role_permissions) cho 3 tab.
 * POST : các hành động quản trị (action trong body):
 *   - create_role     { key, name, description?, cloneFrom? }
 *   - update_role     { id, name?, description?, isActive? }   (tắt role -> bump session mọi user)
 *   - create_permission { key, name, group }
 *   - toggle          { role, permissionKey, allowed }         (gán/gỡ quyền cho role)
 * Mọi write đều invalidatePermissionCache() (hiệu lực request kế tiếp — mục J) + ghi audit.
 */

const KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/;

export async function GET() {
  const guard = await requirePermission(["ADMIN"], "rbac.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const [roleRows, permissionRows, matrix] = await Promise.all([listRoles(), listPermissions(), db.select().from(rolePermissions)]);

  return NextResponse.json({
    roles: roleRows,
    permissions: permissionRows.map((p) => ({
      key: p.key,
      name: p.name,
      group: p.groupName,
      description: p.description,
    })),
    groups: PERMISSION_GROUPS,
    matrix,
    catalogKeys: PERMISSION_CATALOG.map((p) => p.key),
  });
}

export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN"], "rbac.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as Record<string, unknown>;
  const action = String(body.action ?? "");

  try {
    if (action === "create_role") {
      const key = String(body.key ?? "").trim().toUpperCase();
      const name = String(body.name ?? "").trim();
      const cloneFrom = body.cloneFrom ? String(body.cloneFrom) : null;
      if (!KEY_RE.test(key.toLowerCase()) || key.length > 32) {
        return NextResponse.json({ error: "Vai trò key chỉ gồm chữ/số/gạch dưới/chấm, tối đa 32 ký tự." }, { status: 400 });
      }
      if (!name) return NextResponse.json({ error: "Thiếu tên vai trò." }, { status: 400 });
      const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, key)).limit(1);
      if (existing) return NextResponse.json({ error: `Vai trò ${key} đã tồn tại.` }, { status: 409 });

      const [row] = await db
        .insert(roles)
        .values({ key, name, description: body.description ? String(body.description) : null, isSystem: false, isActive: true })
        .returning({ id: roles.id, key: roles.key });

      if (cloneFrom) {
        // CLONE: copy toàn bộ role_permissions của role nguồn (chỉ key đã được cấu hình rõ ràng).
        const srcRows = await db.select({ permissionKey: rolePermissions.permissionKey, allowed: rolePermissions.allowed }).from(rolePermissions).where(eq(rolePermissions.role, cloneFrom));
        if (srcRows.length > 0) {
          await db.insert(rolePermissions).values(srcRows.map((r) => ({ role: key, permissionKey: r.permissionKey, allowed: r.allowed }))).onConflictDoNothing();
        }
      }

      invalidatePermissionCache();
      await writeAudit(guard.session, cloneFrom ? "CLONE_ROLE" : "CREATE_ROLE", "roles", {
        id: row.id,
        key: row.key,
        name,
        ...(cloneFrom ? { cloneFrom } : {}),
      });
      return NextResponse.json({ success: true, row });
    }

    if (action === "update_role") {
      const id = String(body.id ?? "");
      if (!id) return NextResponse.json({ error: "Thiếu ID vai trò." }, { status: 400 });
      const [target] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
      if (!target) return NextResponse.json({ error: "Không tìm thấy vai trò." }, { status: 404 });
      if (target.isSystem && body.isActive === false) {
        return NextResponse.json({ error: "Không thể tắt vai trò hệ thống." }, { status: 400 });
      }

      const patch: { name?: string; description?: string | null; isActive?: boolean } = {};
      if (body.name !== undefined && String(body.name).trim()) patch.name = String(body.name).trim();
      if (body.description !== undefined) patch.description = body.description ? String(body.description) : null;
      if (body.isActive !== undefined) patch.isActive = Boolean(body.isActive);

      const disabling = target.isActive && patch.isActive === false;
      const enabling = !target.isActive && patch.isActive === true;
      if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Không có thay đổi." }, { status: 400 });

      await db.update(roles).set({ ...patch, updatedAt: new Date() }).where(eq(roles.id, id));

      // Mục J — Disable role => bump session_version cho mọi user thuộc role (đăng xuất ngay).
      if (disabling) await bumpSessionVersionForRole(target.key);

      invalidatePermissionCache();
      await writeAudit(guard.session, disabling ? "DISABLE_ROLE" : enabling ? "ENABLE_ROLE" : "UPDATE_ROLE", "roles", {
        id,
        key: target.key,
        changed: Object.keys(patch),
      });
      return NextResponse.json({ success: true });
    }

    if (action === "create_permission") {
      const key = String(body.key ?? "").trim();
      const name = String(body.name ?? "").trim();
      const group = String(body.group ?? "").trim();
      if (!KEY_RE.test(key) || key.length > 64) {
        return NextResponse.json({ error: "Permission key không hợp lệ (chữ/số/gạch dưới/chấm)." }, { status: 400 });
      }
      if (!name || !group) return NextResponse.json({ error: "Thiếu tên hoặc nhóm quyền." }, { status: 400 });

      const [row] = await db
        .insert(permissions)
        .values({ key, name, groupName: group, isSystem: false })
        .onConflictDoNothing()
        .returning({ id: permissions.id, key: permissions.key });
      if (!row) return NextResponse.json({ error: `Quyền ${key} đã tồn tại.` }, { status: 409 });

      invalidatePermissionCache();
      await writeAudit(guard.session, "CREATE_PERMISSION", "permissions", { id: row.id, key: row.key, name, group });
      return NextResponse.json({ success: true, row });
    }

    if (action === "toggle") {
      const role = String(body.role ?? "").trim();
      const permissionKey = String(body.permissionKey ?? "").trim();
      if (!role || !permissionKey) return NextResponse.json({ error: "Thiếu role hoặc permissionKey." }, { status: 400 });
      if (role === "ADMIN") return NextResponse.json({ error: "ADMIN luôn có toàn quyền (bypass) — không cần cấu hình." }, { status: 400 });
      if (!getCatalogPermission(permissionKey) && !KEY_RE.test(permissionKey)) {
        return NextResponse.json({ error: "Permission key không hợp lệ." }, { status: 400 });
      }

      const allowed = Boolean(body.allowed);
      const auditAction = await upsertRolePermission(role, permissionKey, allowed);
      invalidatePermissionCache();
      await writeAudit(guard.session, auditAction, "role_permissions", { role, permissionKey, allowed });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Action không hợp lệ." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: "Lỗi hệ thống: " + (error as Error).message }, { status: 500 });
  }
}
