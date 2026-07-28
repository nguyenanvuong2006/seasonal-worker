import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { rules } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(rules).orderBy(asc(rules.sortOrder));
  return NextResponse.json({ rows });
}

export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "rules.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.name || !Array.isArray(body.conditions) || body.conditions.length === 0 || !Array.isArray(body.actions) || body.actions.length === 0) {
    return NextResponse.json({ error: "Cần có tên, ít nhất 1 điều kiện và 1 hành động." }, { status: 400 });
  }

  const [row] = await db
    .insert(rules)
    .values({
      name: String(body.name),
      entityType: body.entityType || "daily_application",
      trigger: body.trigger || "ON_REGISTER",
      conditions: body.conditions,
      actions: body.actions,
      sortOrder: Number(body.sortOrder) || 100,
    })
    .returning();

  await writeAudit(guard.session, "CREATE_RULE", "rules", { id: row.id, name: row.name });
  return NextResponse.json({ success: true, row });
}

export async function PATCH(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "rules.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["name", "trigger", "conditions", "actions", "sortOrder", "isActive"]) {
    if (k in body) patch[k] = body[k];
  }

  const [row] = await db.update(rules).set(patch).where(eq(rules.id, body.id)).returning();
  await writeAudit(guard.session, "UPDATE_RULE", "rules", { id: body.id });
  return NextResponse.json({ success: true, row });
}

export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "rules.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  await db.delete(rules).where(eq(rules.id, id));
  await writeAudit(guard.session, "DELETE_RULE", "rules", { id });
  return NextResponse.json({ success: true });
}
