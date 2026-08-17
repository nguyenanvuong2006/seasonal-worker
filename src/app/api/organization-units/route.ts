import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { createOrganizationUnit, listAllUnits, OrgTreeError } from "@/lib/organization-units";
import { ORG_UNIT_TYPES } from "@/lib/organization-tree";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cây tổ chức (Org Tree, Phase Org-Tree Step 1) — GET trả TOÀN BỘ node (flat,
 * kèm parentId) để UI tự dựng cây phía client (đủ nhỏ để tải 1 lần — mục 15
 * đề bài: recursive CTE/N+1 chỉ dành cho admin UI, không phải hot-path).
 * Dùng chung permission `departments.manage` với /api/departments hiện có —
 * KHÔNG thêm quyền mới ở PR1 (giữ đúng cam kết "zero behavior change" cho
 * mọi route khác).
 */
export async function GET() {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "departments.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const units = await listAllUnits();
  return NextResponse.json({ units, unitTypes: ORG_UNIT_TYPES });
}

export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "departments.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const body = await req.json();
    const name = String(body.name || "").trim();
    const parentId = String(body.parentId || "").trim();
    const unitType = String(body.unitType || "OTHER").trim();
    if (!name) return NextResponse.json({ error: "Thiếu tên đơn vị." }, { status: 400 });
    if (!parentId) return NextResponse.json({ error: "Thiếu đơn vị cha — mọi node mới phải có cha (chỉ có đúng 1 root)." }, { status: 400 });

    const unit = await createOrganizationUnit({
      name,
      code: body.code ? String(body.code) : null,
      unitType,
      parentId,
      sortOrder: Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : 0,
      actor: { username: guard.session.username },
    });

    await writeAudit(guard.session, "CREATE_ORGANIZATION_UNIT", "organization_units", {
      id: unit.id,
      name: unit.name,
      parentId: unit.parentId,
      path: unit.path,
    });

    return NextResponse.json({ success: true, unit });
  } catch (error) {
    if (error instanceof OrgTreeError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    return NextResponse.json({ error: "Lỗi hệ thống: " + (error as Error).message }, { status: 500 });
  }
}
