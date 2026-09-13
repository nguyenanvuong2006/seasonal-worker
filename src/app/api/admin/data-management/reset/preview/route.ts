import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isResetScope } from "@/lib/data-management/scopes";
import { previewReset } from "@/lib/data-management/reset-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only — computes the dependency-expanded plan + live row counts and
 * mints a short-lived, execute-bound preview token (mission sections 5-6).
 * NEVER writes to the database. The client sends only scope NAMES, never
 * table names (mission section 3) — the server alone decides the actual
 * table/dependency plan via expandResetScopes().
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN"], "data_management.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let body: { scopes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_ARGS", message: "Body JSON không hợp lệ." }, { status: 400 });
  }

  const requested = Array.isArray(body.scopes) ? body.scopes.filter(isResetScope) : [];
  if (requested.length === 0) {
    return NextResponse.json({ error: "INVALID_ARGS", message: "Phải chọn ít nhất một phạm vi hợp lệ." }, { status: 400 });
  }

  const preview = await previewReset({ session: guard.session, requestedScopes: requested });
  return NextResponse.json(preview);
}
