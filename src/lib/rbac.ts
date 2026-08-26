import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { permissions, rolePermissions, roles, users } from "@/db/schema";
import {
  BASELINE_ROLE_PERMISSIONS,
  LEGACY_PERMISSION_KEY_MAP,
  LEGACY_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  SYSTEM_ROLES,
  getCatalogRole,
} from "@/lib/rbac-catalog";

/**
 * DYNAMIC RBAC V2 — seed + helpers phía server.
 * - seedRbacCatalog(): idempotent (ON CONFLICT DO NOTHING) — roles, permissions,
 *   baseline role_permissions, di trú key cũ → key mới. Gọi từ ensureSeed().
 * - isRoleActive / isKnownRoleKey / listRoles / listPermissions: dùng trong route.
 */

export async function seedRbacCatalog(): Promise<void> {
  try {
    // 1) Vai trò hệ thống + HR_DIRECTOR (catalog). onConflictDoNothing → không đè chỉnh sửa của admin.
    await db
      .insert(roles)
      .values(
        SYSTEM_ROLES.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          isSystem: r.isSystem,
          isActive: true,
          sortOrder: r.sortOrder,
        })),
      )
      .onConflictDoNothing();

    // 2) Danh mục quyền.
    await db
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.map((p) => ({
          key: p.key,
          name: p.name,
          groupName: p.group,
          isSystem: true,
        })),
      )
      .onConflictDoNothing();

    // 3) Baseline role_permissions cho mọi (role, key) — KHÔNG đè cấu hình admin đã có.
    const baselineRows = Object.entries(BASELINE_ROLE_PERMISSIONS).flatMap(([role, keys]) =>
      keys.map((permissionKey) => ({ role, permissionKey, allowed: true })),
    );
    if (baselineRows.length > 0) {
      await db.insert(rolePermissions).values(baselineRows).onConflictDoNothing();
    }

    // 4) Di trú key cũ → key mới (vd workers.view → dw.view + worker_profile.view):
    //    copy giá trị `allowed` của dòng cũ sang key mới để không mất ý định khoá quyền.
    const legacyRows = await db
      .select({ role: rolePermissions.role, permissionKey: rolePermissions.permissionKey, allowed: rolePermissions.allowed })
      .from(rolePermissions)
      .where(inArray(rolePermissions.permissionKey, LEGACY_PERMISSION_KEYS));
    const migrated = legacyRows.flatMap((r) =>
      (LEGACY_PERMISSION_KEY_MAP[r.permissionKey] ?? []).map((newKey) => ({
        role: r.role,
        permissionKey: newKey,
        allowed: r.allowed,
      })),
    );
    if (migrated.length > 0) {
      await db.insert(rolePermissions).values(migrated).onConflictDoNothing();
    }
  } catch (error) {
    // Seed RBAC không bao giờ được làm sập luồng khởi động (bảng catalog có thể chưa tồn tại
    // nếu deploy code TRƯỚC khi chạy migration — auth.ts có fallback baseline in-memory).
    console.error("[rbac] seedRbacCatalog failed", error);
  }
}

export type RoleRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  memberCount: number;
};

/** Danh sách vai trò kèm số thành viên (dùng cho trang Phân quyền tab "Vai trò"). */
export async function listRoles(): Promise<RoleRow[]> {
  const rows = await db.select().from(roles).orderBy(asc0());
  if (rows.length === 0) {
    // Fallback: chưa có bảng/catalog → trả baseline in-memory (deploy code trước migration).
    return SYSTEM_ROLES.map((r) => ({
      id: `catalog-${r.key}`,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      isActive: true,
      sortOrder: r.sortOrder,
      memberCount: 0,
    }));
  }
  const counts = await db
    .select({ role: users.role, c: sql<number>`count(*)::int` })
    .from(users)
    .where(inArray(users.role, rows.map((r) => r.key)))
    .groupBy(users.role);
  const countMap = new Map(counts.map((c) => [c.role, c.c]));
  return rows.map((r) => ({ ...r, memberCount: countMap.get(r.key) ?? 0 }));
}

function asc0() {
  return sql`sort_order asc, key asc`;
}

/** Kiểm tra role key có hợp lệ (tồn tại trong bảng roles HOẶC baseline catalog) không. */
export async function isKnownRoleKey(key: string): Promise<boolean> {
  if (getCatalogRole(key)) return true;
  try {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, key)).limit(1);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** Role có đang bật (isActive) không — dùng ở login; lỗi DB → coi như bật (fallback). */
export async function isRoleActive(key: string): Promise<boolean> {
  try {
    const [row] = await db.select({ isActive: roles.isActive }).from(roles).where(eq(roles.key, key)).limit(1);
    if (!row) return Boolean(getCatalogRole(key));
    return row.isActive;
  } catch {
    return true;
  }
}

/** Lấy label hiển thị cho 1 role key (ưu tiên DB, fallback catalog, fallback key). */
export async function getRoleLabel(key: string): Promise<string> {
  try {
    const [row] = await db.select({ name: roles.name }).from(roles).where(eq(roles.key, key)).limit(1);
    if (row) return row.name;
  } catch {
    /* fallback */
  }
  return getCatalogRole(key)?.name ?? key;
}

export async function listPermissions() {
  try {
    const rows = await db.select().from(permissions).orderBy(sql`group_name asc, key asc`);
    if (rows.length > 0) return rows;
  } catch {
    /* fallback */
  }
  return PERMISSION_CATALOG.map((p) => ({
    id: `catalog-${p.key}`,
    key: p.key,
    name: p.name,
    groupName: p.group,
    description: null,
    isSystem: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}

/** Vô hiệu hoá mọi phiên đang hoạt động của user thuộc 1 role (PR mục J). */
export async function bumpSessionVersionForRole(roleKey: string): Promise<void> {
  await db
    .update(users)
    .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
    .where(and(eq(users.role, roleKey), eq(users.isActive, true)));
}

/** Lấy ma trận (role, permissionKey, allowed) hiện có. */
export async function listRolePermissionMatrix() {
  const rows = await db.select().from(rolePermissions).orderBy(desc(rolePermissions.createdAt));
  return rows;
}

/**
 * Gán / gỡ 1 quyền cho 1 role (upsert) — trả về action audit tương ứng.
 *
 * `client` mặc định là `db` (dùng cho toggle đơn lẻ, hành vi không đổi) — Batch
 * Permission Editor truyền vào `tx` (từ `db.transaction()`) để MỌI upsert của
 * cùng 1 lần lưu chạy trong CÙNG một transaction: lỗi ở bất kỳ dòng nào rollback
 * toàn bộ, không bao giờ để role ở trạng thái quyền nửa vời.
 */
export async function upsertRolePermission(
  roleKey: string,
  permissionKey: string,
  allowed: boolean,
  client: Pick<typeof db, "select" | "update" | "insert"> = db,
): Promise<"ASSIGN_PERMISSION_TO_ROLE" | "REMOVE_PERMISSION_FROM_ROLE"> {
  const [existing] = await client
    .select()
    .from(rolePermissions)
    .where(and(eq(rolePermissions.role, roleKey), eq(rolePermissions.permissionKey, permissionKey)));
  if (existing) {
    await client.update(rolePermissions).set({ allowed }).where(eq(rolePermissions.id, existing.id));
  } else {
    await client.insert(rolePermissions).values({ role: roleKey, permissionKey, allowed });
  }
  return allowed ? "ASSIGN_PERMISSION_TO_ROLE" : "REMOVE_PERMISSION_FROM_ROLE";
}
