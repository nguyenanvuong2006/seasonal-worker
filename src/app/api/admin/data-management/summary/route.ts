import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getDataManagementSummary } from "@/lib/data-management/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Global, high-privilege administrative workflow (mission section 51) —
 * ADMIN role only, regardless of Data Scope. Normal recruiters/managers
 * must never see this page.
 */
export async function GET() {
  const guard = await requirePermission(["ADMIN"], "data_management.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const summary = await getDataManagementSummary();
  return NextResponse.json(summary);
}
