import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { workflowStages } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { invalidateWorkflowCache } from "@/lib/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(workflowStages).orderBy(asc(workflowStages.sortOrder));
  return NextResponse.json({ rows });
}

export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "workflow.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const body = await req.json();
    const stageKey = String(body.stageKey || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_");
    if (!stageKey || !body.label) {
      return NextResponse.json({ error: "Thiếu mã bước hoặc tên hiển thị." }, { status: 400 });
    }

    const [row] = await db
      .insert(workflowStages)
      .values({
        entityType: body.entityType || "daily_application",
        stageKey,
        label: String(body.label),
        color: body.color || "gray",
        sortOrder: Number(body.sortOrder) || 100,
        isStart: Boolean(body.isStart),
        isEnd: Boolean(body.isEnd),
        allowedRoles: Array.isArray(body.allowedRoles) && body.allowedRoles.length ? body.allowedRoles : ["ADMIN", "HR_RECRUITER"],
      })
      .returning();

    invalidateWorkflowCache();
    await writeAudit(guard.session, "CREATE_WORKFLOW_STAGE", "workflow_stages", { id: row.id, stageKey });
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return NextResponse.json(
      { error: "Mã bước đã tồn tại hoặc dữ liệu sai: " + (error as Error).message },
      { status: 400 },
    );
  }
}

export async function PATCH(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "workflow.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["label", "color", "sortOrder", "isStart", "isEnd", "allowedRoles", "isActive"]) {
    if (k in body) patch[k] = body[k];
  }

  const [row] = await db.update(workflowStages).set(patch).where(eq(workflowStages.id, body.id)).returning();
  invalidateWorkflowCache();
  await writeAudit(guard.session, "UPDATE_WORKFLOW_STAGE", "workflow_stages", { id: body.id });
  return NextResponse.json({ success: true, row });
}

export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "workflow.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  await db.delete(workflowStages).where(eq(workflowStages.id, id));
  invalidateWorkflowCache();
  await writeAudit(guard.session, "DELETE_WORKFLOW_STAGE", "workflow_stages", { id });
  return NextResponse.json({ success: true });
}
