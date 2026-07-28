import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { dashboardWidgets } from "@/db/schema";
import { getUserScope, requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { getKpiValue, getRecentApplicationsTable } from "@/lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Trả về widget đã cấu hình KÈM dữ liệu đã tính sẵn (KPI: số; TABLE: headers+rows).
 *  DEPT_MANAGER chỉ thấy số liệu trong Data Scope của mình (Phase 2, Step 6). */
export async function GET() {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], "dashboard.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const scope = await getUserScope(guard.session);

  const widgets = await db
    .select()
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.isActive, true))
    .orderBy(asc(dashboardWidgets.sortOrder));

  const withData = await Promise.all(
    widgets.map(async (w) => {
      if (w.widgetType === "KPI") {
        const metric = String((w.config as { metric?: string })?.metric ?? "");
        return { ...w, value: await getKpiValue(metric, scope) };
      }
      const table = await getRecentApplicationsTable(10, scope);
      return { ...w, table };
    }),
  );

  return NextResponse.json({ rows: withData, scoped: scope !== null });
}

export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "dashboard.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.title || !body.widgetType) return NextResponse.json({ error: "Thiếu tiêu đề hoặc loại widget." }, { status: 400 });

  const [row] = await db
    .insert(dashboardWidgets)
    .values({
      title: String(body.title),
      widgetType: body.widgetType,
      dataSource: body.dataSource || "daily_applications",
      config: body.config || {},
      sortOrder: Number(body.sortOrder) || 100,
    })
    .returning();

  await writeAudit(guard.session, "CREATE_DASHBOARD_WIDGET", "dashboard_widgets", { id: row.id });
  return NextResponse.json({ success: true, row });
}

export async function PATCH(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "dashboard.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const patch: Record<string, unknown> = {};
  for (const k of ["title", "sortOrder", "isActive", "config"]) {
    if (k in body) patch[k] = body[k];
  }
  const [row] = await db.update(dashboardWidgets).set(patch).where(eq(dashboardWidgets.id, body.id)).returning();
  await writeAudit(guard.session, "UPDATE_DASHBOARD_WIDGET", "dashboard_widgets", { id: body.id });
  return NextResponse.json({ success: true, row });
}

export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "dashboard.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });
  await db.delete(dashboardWidgets).where(eq(dashboardWidgets.id, id));
  await writeAudit(guard.session, "DELETE_DASHBOARD_WIDGET", "dashboard_widgets", { id });
  return NextResponse.json({ success: true });
}
