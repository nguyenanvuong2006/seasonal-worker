import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { moveOrganizationUnit, OrgTreeError } from "@/lib/organization-units";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Di chuyển 1 node sang làm con của 1 đơn vị khác — cả subtree đi theo (path
 * được cascade lại trong 1 UPDATE, không xoá/insert lại — xem
 * src/lib/organization-units.ts). Circular parent (di chuyển vào chính nó
 * hoặc con cháu của nó) bị chặn ở tầng service, trả 400 rõ lý do.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "departments.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  try {
    const body = await req.json();
    const newParentId = String(body.newParentId || "").trim();
    if (!newParentId) return NextResponse.json({ error: "Thiếu đơn vị cha mới." }, { status: 400 });

    const unit = await moveOrganizationUnit({ id, newParentId, actor: { username: guard.session.username } });

    await writeAudit(guard.session, "MOVE_ORGANIZATION_UNIT", "organization_units", {
      id,
      newParentId,
      newPath: unit.path,
    });

    return NextResponse.json({ success: true, unit });
  } catch (error) {
    if (error instanceof OrgTreeError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    return NextResponse.json({ error: "Lỗi hệ thống: " + (error as Error).message }, { status: 500 });
  }
}
