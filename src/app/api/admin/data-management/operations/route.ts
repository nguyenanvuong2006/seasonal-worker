import { NextResponse } from "next/server";
import { desc, like } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { requirePermission } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operation history (mission section 12/40) — reuses audit_logs (never a
 * second audit system), filtered to this feature's own action prefix. This
 * table is explicitly EXCLUDED from every reset scope (see scopes.ts) so a
 * Factory Reset can never erase its own history.
 */
export async function GET() {
  const guard = await requirePermission(["ADMIN"], "data_management.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rows = await db
    .select()
    .from(auditLogs)
    .where(like(auditLogs.action, "DATA_MANAGEMENT_%"))
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);

  return NextResponse.json({ operations: rows });
}
