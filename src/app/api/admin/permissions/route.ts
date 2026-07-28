import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { rolePermissions } from "@/db/schema";
import { invalidatePermissionCache, requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PERMISSION_KEYS = [
  { key: "registrations.view", label: "Xem Daily Application" },
  { key: "registrations.edit", label: "Sửa Daily Application" },
  { key: "registrations.approve", label: "Duyệt/Từ chối hồ sơ" },
  { key: "registrations.export", label: "Xuất Excel" },
  { key: "workers.view", label: "Xem DW Data" },
  { key: "workers.edit", label: "Sửa/Xoá DW Data" },
  { key: "departments.manage", label: "Quản lý Department" },
  { key: "questions.manage", label: "Quản lý Câu hỏi động (Form Builder)" },
  { key: "users.manage", label: "Quản lý tài khoản" },
  { key: "field_definitions.manage", label: "Quản lý Trường dữ liệu (Metadata)" },
  { key: "import.run", label: "Nhập dữ liệu (Import)" },
  { key: "recycle_bin.manage", label: "Quản lý Thùng rác" },
  { key: "history.manage", label: "Xem/Khôi phục Lịch sử" },
  { key: "workflow.manage", label: "Quản lý Workflow" },
  { key: "rules.manage", label: "Quản lý Rule Engine" },
  { key: "permissions.manage", label: "Quản lý Phân quyền chi tiết" },
  { key: "notifications.manage", label: "Quản lý hàng đợi Thông báo" },
  { key: "dashboard.manage", label: "Quản lý Dashboard" },
  { key: "backup.manage", label: "Backup dữ liệu" },
  { key: "system.view", label: "Xem Health Monitor" },
  { key: "privacy.view_cccd", label: "Xem CCCD khi Export" },
  { key: "privacy.view_phone", label: "Xem SĐT khi Export" },
  { key: "privacy.view_address", label: "Xem Địa chỉ khi Export" },
  { key: "data_scopes.manage", label: "Quản lý Data Scope (Manager quản lý bộ phận nào)" },
  { key: "workforce_movements.view", label: "Xem yêu cầu Nghỉ việc/Thuyên chuyển" },
  { key: "workforce_movements.create", label: "Tạo yêu cầu Nghỉ việc/Thuyên chuyển" },
  { key: "workforce_movements.manage", label: "HR xử lý yêu cầu Nghỉ việc/Thuyên chuyển" },
  { key: "planning.view", label: "Xem Planning" },
  { key: "planning.manage", label: "Quản lý Planning (tạo/sửa/kích hoạt)" },
] as const;

export const ROLES = ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"] as const;

export async function GET() {
  const rows = await db.select().from(rolePermissions);
  return NextResponse.json({ rows, keys: PERMISSION_KEYS, roles: ROLES });
}

/** Bật/tắt 1 quyền cho 1 role (upsert). */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "permissions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as { role?: string; permissionKey?: string; allowed?: boolean };
  if (!body.role || !body.permissionKey) return NextResponse.json({ error: "Thiếu role hoặc permissionKey." }, { status: 400 });

  const [existing] = await db
    .select()
    .from(rolePermissions)
    .where(and(eq(rolePermissions.role, body.role), eq(rolePermissions.permissionKey, body.permissionKey)));

  if (existing) {
    await db.update(rolePermissions).set({ allowed: Boolean(body.allowed) }).where(eq(rolePermissions.id, existing.id));
  } else {
    await db.insert(rolePermissions).values({ role: body.role, permissionKey: body.permissionKey, allowed: Boolean(body.allowed) });
  }

  invalidatePermissionCache();
  await writeAudit(guard.session, "UPDATE_PERMISSION", "role_permissions", { role: body.role, permissionKey: body.permissionKey, allowed: body.allowed });
  return NextResponse.json({ success: true });
}
