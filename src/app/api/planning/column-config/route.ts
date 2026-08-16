import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { planningColumnConfigs } from "@/db/schema";
import { getSession, hasPermission, requirePermission, writeAudit } from "@/lib/auth";
import {
  ALL_COLUMN_KEYS,
  RECRUITMENT_REQUEST_COLUMNS,
  resolveColumnsForRole,
  type DeviceKind,
  type StoredColumnConfigItem,
} from "@/lib/recruitment-request-columns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ============================================================
   CẤU HÌNH CỘT BẢNG PLANNING (Yêu cầu #2)
   ------------------------------------------------------------
   Cấu hình được LƯU TRONG DB (planning_column_configs), KHÔNG
   phải localStorage — Admin đổi một lần, mọi máy/mọi phiên đều
   thấy. UI không hardcode danh sách cột: nó gọi GET ở đây và
   render đúng những gì nhận được.
   ============================================================ */

const DEVICES: DeviceKind[] = ["desktop", "mobile"];

function parseDevice(value: string | null): DeviceKind {
  return value === "mobile" ? "mobile" : "desktop";
}

/**
 * GET /api/planning/column-config?role=&device=
 *
 * Trả về catalog cột đã hợp nhất với cấu hình đã lưu, cho một vai trò.
 * - Không truyền `role` → lấy theo vai trò của chính người đang đăng nhập
 *   (ai cũng đọc được cấu hình của chính mình để render bảng).
 * - Truyền `role` khác → chỉ Admin có quyền planning.columns.manage mới xem được.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  const url = new URL(req.url);
  const device = parseDevice(url.searchParams.get("device"));
  const requestedRole = url.searchParams.get("role");
  const role = requestedRole ?? session.role;

  if (requestedRole && requestedRole !== session.role) {
    const guard = await requirePermission(["ADMIN"], "planning.columns.manage");
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const stored = await db
    .select({
      columnKey: planningColumnConfigs.columnKey,
      visible: planningColumnConfigs.visible,
      sticky: planningColumnConfigs.sticky,
      sortOrder: planningColumnConfigs.sortOrder,
    })
    .from(planningColumnConfigs)
    .where(and(eq(planningColumnConfigs.role, role), eq(planningColumnConfigs.device, device)));

  const columns = resolveColumnsForRole(role, device, stored as StoredColumnConfigItem[]);

  // Khả năng thao tác của CHÍNH người đang đăng nhập. UI dùng để ẩn/hiện nút,
  // nhưng mọi API vẫn tự kiểm tra quyền lần nữa ở phía server (Yêu cầu #15).
  const [canImport, canEdit, canReallocate, canManageColumns, canComment, canRequest] = await Promise.all([
    hasPermission(session.role, "planning.import"),
    hasPermission(session.role, "planning.edit"),
    hasPermission(session.role, "planning.reallocate"),
    hasPermission(session.role, "planning.columns.manage"),
    hasPermission(session.role, "planning.comment"),
    hasPermission(session.role, "planning.request"),
  ]);

  return NextResponse.json({
    role,
    device,
    sessionRole: session.role,
    capabilities: { canImport, canEdit, canReallocate, canManageColumns, canComment, canRequest },
    /** true nếu đang dùng mặc định theo vai trò (chưa có bản ghi cấu hình nào). */
    usingDefaults: stored.length === 0,
    columns,
    /** Catalog đầy đủ để Admin dựng màn hình Column Chooser. */
    catalog: RECRUITMENT_REQUEST_COLUMNS,
  });
}

/**
 * PUT /api/planning/column-config
 * body: { role, device, columns: [{ columnKey, visible, sticky, sortOrder }] }
 *
 * Ghi đè cấu hình của (role, device). Chạy trong transaction; cột không gửi lên
 * sẽ quay về mặc định của vai trò.
 */
export async function PUT(req: Request) {
  const guard = await requirePermission(["ADMIN"], "planning.columns.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    role?: string;
    device?: string;
    columns?: { columnKey?: string; visible?: boolean; sticky?: boolean; sortOrder?: number }[];
  };

  const role = (body.role ?? "").trim().toUpperCase();
  if (!role) return NextResponse.json({ error: "Thiếu vai trò." }, { status: 400 });

  const device = parseDevice(body.device ?? null);
  if (!DEVICES.includes(device)) return NextResponse.json({ error: "Thiết bị không hợp lệ." }, { status: 400 });

  const items = Array.isArray(body.columns) ? body.columns : [];
  if (items.length === 0) return NextResponse.json({ error: "Danh sách cột trống." }, { status: 400 });
  if (items.length > ALL_COLUMN_KEYS.length) {
    return NextResponse.json({ error: "Danh sách cột vượt quá số cột hiện có." }, { status: 400 });
  }

  const seen = new Set<string>();
  const rows: {
    role: string;
    device: string;
    columnKey: string;
    visible: boolean;
    sticky: boolean;
    sortOrder: number;
    updatedBy: string;
  }[] = [];

  for (const [index, item] of items.entries()) {
    const key = (item.columnKey ?? "").trim();
    if (!ALL_COLUMN_KEYS.includes(key)) {
      return NextResponse.json({ error: `Cột không hợp lệ: ${key || "(trống)"}` }, { status: 400 });
    }
    if (seen.has(key)) return NextResponse.json({ error: `Cột bị lặp: ${key}` }, { status: 400 });
    seen.add(key);

    rows.push({
      role,
      device,
      columnKey: key,
      visible: item.visible !== false,
      sticky: item.sticky === true,
      sortOrder: Number.isFinite(item.sortOrder) ? Number(item.sortOrder) : index,
      updatedBy: guard.session.username,
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(planningColumnConfigs)
      .where(and(eq(planningColumnConfigs.role, role), eq(planningColumnConfigs.device, device)));
    await tx.insert(planningColumnConfigs).values(rows);
  });

  await writeAudit(guard.session, "UPDATE_PLANNING_COLUMN_CONFIG", "planning_column_configs", {
    role,
    device,
    columnCount: rows.length,
    visibleCount: rows.filter((r) => r.visible).length,
  });

  return NextResponse.json({ success: true, role, device, columns: resolveColumnsForRole(role, device, rows) });
}

/**
 * DELETE /api/planning/column-config?role=&device=
 * Xoá cấu hình tuỳ chỉnh → quay về mặc định theo vai trò.
 */
export async function DELETE(req: Request) {
  const guard = await requirePermission(["ADMIN"], "planning.columns.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const role = (url.searchParams.get("role") ?? "").trim().toUpperCase();
  const device = parseDevice(url.searchParams.get("device"));
  if (!role) return NextResponse.json({ error: "Thiếu vai trò." }, { status: 400 });

  await db
    .delete(planningColumnConfigs)
    .where(and(eq(planningColumnConfigs.role, role), eq(planningColumnConfigs.device, device)));

  await writeAudit(guard.session, "RESET_PLANNING_COLUMN_CONFIG", "planning_column_configs", { role, device });
  return NextResponse.json({ success: true, role, device, usingDefaults: true });
}
