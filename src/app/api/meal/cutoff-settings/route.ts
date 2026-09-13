import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { getMealCutoffSettings, updateMealCutoffTime } from "@/lib/meal-cutoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** MISSION E section 15 — configurable Báo cơm cutoff time (mealCutoffTime). ADMIN-level (`meal.configure`). */
export async function GET() {
  const guard = await requirePermission(["ADMIN", "MEAL_STAFF"], "meal.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const settings = await getMealCutoffSettings();
  return NextResponse.json(settings);
}

export async function PATCH(req: Request) {
  const guard = await requirePermission(["ADMIN"], "meal.configure");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.cutoffTime !== "string") {
    return NextResponse.json({ error: "Thiếu cutoffTime." }, { status: 400 });
  }

  const result = await updateMealCutoffTime(body.cutoffTime, guard.session.username);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  await writeAudit(guard.session, "UPDATE_MEAL_CUTOFF_TIME", "meal_cutoff_settings", { cutoffTime: body.cutoffTime });
  return NextResponse.json({ success: true, cutoffTime: body.cutoffTime });
}
