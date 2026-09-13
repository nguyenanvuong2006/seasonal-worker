import { NextResponse } from "next/server";
import { hasPermission, requirePermission } from "@/lib/auth";
import { permissionKeysForScopes } from "@/lib/data-management/scopes";
import { verifyResetPreviewToken } from "@/lib/data-management/preview-token";
import { executeReset } from "@/lib/data-management/reset-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Destructive. Requires: data_management.view (base gate) + the scope-
 * specific permission(s) for the token's effective scopes (mission section
 * 8 — a normal Data Management viewer/importer does NOT automatically get
 * reset rights) + a valid, non-expired, non-tampered preview token bound to
 * those exact scopes + the exact typed confirmation phrase + the
 * environment guard + a free advisory lock. Any one of these failing means
 * zero writes (executeReset() only mutates inside its own transaction,
 * after every check above already passed).
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN"], "data_management.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let body: { previewToken?: unknown; confirmationPhrase?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_ARGS", message: "Body JSON không hợp lệ." }, { status: 400 });
  }
  if (typeof body.previewToken !== "string" || typeof body.confirmationPhrase !== "string") {
    return NextResponse.json({ error: "INVALID_ARGS", message: "Thiếu previewToken hoặc confirmationPhrase." }, { status: 400 });
  }

  const verified = await verifyResetPreviewToken(body.previewToken);
  if (!verified.ok) {
    return NextResponse.json({ error: "RESET_PREVIEW_EXPIRED", message: verified.reason === "EXPIRED" ? "Preview đã hết hạn — hãy tạo preview mới." : "Preview token không hợp lệ." }, { status: 400 });
  }

  const requiredPermissions = permissionKeysForScopes(verified.payload.effectiveScopes);
  for (const key of requiredPermissions) {
    const allowed = await hasPermission(guard.session.role, key);
    if (!allowed) {
      return NextResponse.json({ error: "FORBIDDEN", message: `Tài khoản của bạn không có quyền "${key}" cần cho phạm vi reset này.` }, { status: 403 });
    }
  }

  const result = await executeReset({ session: guard.session, previewToken: body.previewToken, confirmationPhrase: body.confirmationPhrase });
  if (!result.ok) {
    const status = result.error.code === "DATA_MANAGEMENT_BUSY" ? 409 : 400;
    return NextResponse.json({ error: result.error.code, message: result.error.message }, { status });
  }

  return NextResponse.json({ success: true, effectiveScopes: result.effectiveScopes, rowCountsDeleted: result.rowCountsDeleted, operationId: result.operationId });
}
