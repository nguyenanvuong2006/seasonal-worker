import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { getDwCodeLocation, updateDwCodeLocation } from "@/lib/dw-code-locations-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN"], "dw_code.configure");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await params;
  const location = await getDwCodeLocation(id);
  if (!location) return NextResponse.json({ error: "Không tìm thấy cấu hình địa điểm." }, { status: 404 });

  return NextResponse.json({ success: true, location });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN"], "dw_code.configure");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });

  const result = await updateDwCodeLocation(id, {
    name: body.name !== undefined ? String(body.name) : undefined,
    prefix: body.prefix !== undefined ? String(body.prefix) : undefined,
    sequenceDigits: body.sequenceDigits !== undefined ? Number(body.sequenceDigits) : undefined,
    separator: body.separator !== undefined ? String(body.separator) : undefined,
    suffix: body.suffix !== undefined ? String(body.suffix) : undefined,
    startNumber: body.startNumber !== undefined ? Number(body.startNumber) : undefined,
    isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
    updatedBy: guard.session.username,
  });

  if (!result.ok) {
    const status =
      result.error === "LOCATION_NOT_FOUND" ? 404 :
      result.error === "INVALID_INPUT" ? 400 : 409;
    return NextResponse.json({ error: result.message, code: result.error, field: result.field }, { status });
  }

  await writeAudit(guard.session, "UPDATE_DW_CODE_LOCATION", "dw_code_locations", { id, patch: body });
  return NextResponse.json({ success: true, location: result.location });
}

