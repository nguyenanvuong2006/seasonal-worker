import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { updateDwCodeLocation, validateDwCodeLocationInput } from "@/lib/dw-code-locations-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** startNumber/nextSequence intentionally NOT patchable here (mission section 51). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN"], "dw_code.configure");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });

  if (body.name !== undefined || body.prefix !== undefined || body.sequenceDigits !== undefined || body.separator !== undefined || body.suffix !== undefined) {
    const validationError = validateDwCodeLocationInput({
      name: body.name ?? "x",
      prefix: (body.prefix ?? "X").toUpperCase(),
      sequenceDigits: body.sequenceDigits ?? 5,
      separator: body.separator ?? "-",
      suffix: (body.suffix ?? "D").toUpperCase(),
      startNumber: 0,
    });
    if (validationError) return NextResponse.json({ error: validationError.message, field: validationError.field }, { status: 400 });
  }

  const updated = await updateDwCodeLocation(id, {
    name: body.name !== undefined ? String(body.name) : undefined,
    prefix: body.prefix !== undefined ? String(body.prefix) : undefined,
    sequenceDigits: body.sequenceDigits !== undefined ? Number(body.sequenceDigits) : undefined,
    separator: body.separator !== undefined ? String(body.separator) : undefined,
    suffix: body.suffix !== undefined ? String(body.suffix) : undefined,
    isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
    updatedBy: guard.session.username,
  });
  if (!updated) return NextResponse.json({ error: "Không tìm thấy cấu hình." }, { status: 404 });

  await writeAudit(guard.session, "UPDATE_DW_CODE_LOCATION", "dw_code_locations", { id, patch: body });
  return NextResponse.json({ success: true, location: updated });
}
