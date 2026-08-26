import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { permissions, rolePermissions, roles } from "@/db/schema";
import { invalidatePermissionCache, requirePermission, writeAudit } from "@/lib/auth";
import { getCatalogPermission, PERMISSION_CATALOG, PERMISSION_GROUPS } from "@/lib/rbac-catalog";
import { bumpSessionVersionForRole, isKnownRoleKey, listPermissions, listRoles, upsertRolePermission } from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DYNAMIC RBAC V2 — /api/admin/permissions
 * GET  : catalog đầy đủ (roles + permissions + groups + ma trận role_permissions) cho 3 tab.
 * POST : các hành động quản trị (action trong body):
 *   - create_role     { key, name, description?, cloneFrom? }
 *   - update_role     { id, name?, description?, isActive? }   (tắt role -> bump session mọi user)
 *   - create_permission { key, name, group }
 *   - toggle          { role, permissionKey, allowed }         (gán/gỡ quyền cho role — 1 quyền)
 *   - batch_update_permissions { role, changes: [{permissionKey, allowed}] }
 *       (Batch Permission Editor — nhiều quyền trong 1 request, 1 transaction,
 *       1 invalidatePermissionCache(), 1 audit log — xem hàm bên dưới.)
 * Mọi write đều invalidatePermissionCache() (hiệu lực request kế tiếp — mục J) + ghi audit.
 */

const KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/;
/** Chặn payload bất thường trước khi mở transaction — catalog thật hiện ~70 quyền. */
const MAX_BATCH_CHANGES = 300;

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
      if (!(await isKnownRoleKey(role))) return NextResponse.json({ error: `Vai trò "${role}" không tồn tại.` }, { status: 400 });
      if (!getCatalogPermission(permissionKey) && !KEY_RE.test(permissionKey)) {
        return NextResponse.json({ error: "Permission key không hợp lệ." }, { status: 400 });
      }

      const allowed = Boolean(body.allowed);
      const auditAction = await upsertRolePermission(role, permissionKey, allowed);
      invalidatePermissionCache();
      await writeAudit(guard.session, auditAction, "role_permissions", { role, permissionKey, allowed });
      return NextResponse.json({ success: true });
    }

    /**
     * BATCH PERMISSION EDITOR — accepts every pending change for ONE role in a
     * single request instead of one HTTP round-trip per toggle.
     *
     * TRANSACTION SAFETY: all upserts run inside ONE db.transaction() — if any
     * row fails, the whole batch throws and is caught below (500), and Postgres
     * rolls back every mutation from this request. The role is never left with
     * a partially-applied permission set.
     *
     * CACHE: invalidatePermissionCache() is called exactly ONCE, after the
     * transaction commits — never once per change.
     *
     * AUDIT: ONE audit row for the whole batch (BATCH_UPDATE_ROLE_PERMISSIONS),
     * carrying enabled/disabled counts and the full list of changed keys in
     * structured `details` — not one row per permission.
     *
     * VALIDATION (never trusts role/permissionKey from the client):
     *   - role must exist (isKnownRoleKey) and must not be "ADMIN";
     *   - every permissionKey must be a real catalog key or match the key
     *     shape already enforced for `create_permission`/`toggle`;
     *   - duplicate permissionKeys in one payload keep only the LAST value
     *     (what the UI's own local dirty-state map would produce anyway).
     */
    if (action === "batch_update_permissions") {
      const role = String(body.role ?? "").trim();
      if (!role) return NextResponse.json({ error: "Thiếu vai trò." }, { status: 400 });
      if (role === "ADMIN") return NextResponse.json({ error: "ADMIN luôn có toàn quyền (bypass) — không cần cấu hình." }, { status: 400 });
      if (!(await isKnownRoleKey(role))) return NextResponse.json({ error: `Vai trò "${role}" không tồn tại.` }, { status: 400 });

      const rawChanges = Array.isArray(body.changes) ? body.changes : [];
      if (rawChanges.length === 0) return NextResponse.json({ error: "Không có thay đổi nào để lưu." }, { status: 400 });
      if (rawChanges.length > MAX_BATCH_CHANGES) {
        return NextResponse.json({ error: `Quá nhiều thay đổi trong 1 lần lưu (tối đa ${MAX_BATCH_CHANGES}).` }, { status: 400 });
      }

      const changeByKey = new Map<string, boolean>();
      for (const raw of rawChanges) {
        if (!raw || typeof raw !== "object") {
          return NextResponse.json({ error: "Dữ liệu thay đổi không hợp lệ." }, { status: 400 });
        }
        const permissionKey = String((raw as Record<string, unknown>).permissionKey ?? "").trim();
        if (!permissionKey) return NextResponse.json({ error: "Thiếu permissionKey trong một thay đổi." }, { status: 400 });
        if (!getCatalogPermission(permissionKey) && !KEY_RE.test(permissionKey)) {
          return NextResponse.json({ error: `Permission key không hợp lệ: ${permissionKey}` }, { status: 400 });
        }
        changeByKey.set(permissionKey, Boolean((raw as Record<string, unknown>).allowed));
      }
      const changes = [...changeByKey.entries()].map(([permissionKey, allowed]) => ({ permissionKey, allowed }));

      await db.transaction(async (tx) => {
        for (const { permissionKey, allowed } of changes) {
          await upsertRolePermission(role, permissionKey, allowed, tx);
        }
      });

      // ONE cache invalidation for the whole batch, only after commit.
      invalidatePermissionCache();

      const enabledCount = changes.filter((c) => c.allowed).length;
      const disabledCount = changes.length - enabledCount;
      // ONE audit row for the whole batch, not one per permission.
      await writeAudit(guard.session, "BATCH_UPDATE_ROLE_PERMISSIONS", "role_permissions", {
        role,
        enabledCount,
        disabledCount,
        changedKeys: changes.map((c) => c.permissionKey),
      });

      return NextResponse.json({ success: true, applied: changes.length, enabledCount, disabledCount });
    }

    return NextResponse.json({ error: "Action không hợp lệ." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: "Lỗi hệ thống: " + (error as Error).message }, { status: 500 });
  }
}
