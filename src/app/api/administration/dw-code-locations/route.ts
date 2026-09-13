import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  createDwCodeLocation,
  listDwCodeLocations,
  validateDwCodeLocationInput,
} from "@/lib/dw-code-locations-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MISSION E section 4-7, 48, 52 — admin config for the Internal DW Code
 * namespace per operational location (Organization Unit type LOCATION).
 * High-level ADMIN-only capability (`dw_code.configure`) — deliberately
 * separate from `administration.daily_code.submit` (daily code assign/
 * release), which is an operational, not configuration, action.
 */
export async function GET() {
  const guard = await requirePermission(["ADMIN"], "dw_code.configure");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rows = await listDwCodeLocations();
  return NextResponse.json({ rows });
}

export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN"], "dw_code.configure");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.organizationUnitId !== "string" || !body.organizationUnitId) {
    return NextResponse.json({ error: "Thiếu đơn vị tổ chức (Location)." }, { status: 400 });
  }

  const input = {
    name: String(body.name ?? ""),
    prefix: String(body.prefix ?? "").toUpperCase(),
    sequenceDigits: Number(body.sequenceDigits ?? 5),
    separator: String(body.separator ?? "-"),
    suffix: String(body.suffix ?? "D").toUpperCase(),
    startNumber: Number(body.startNumber ?? 1),
  };
  const validationError = validateDwCodeLocationInput(input);
  if (validationError) return NextResponse.json({ error: validationError.message, field: validationError.field }, { status: 400 });

  try {
    const created = await createDwCodeLocation({
      organizationUnitId: body.organizationUnitId,
      ...input,
      createdBy: guard.session.username,
    });
    await writeAudit(guard.session, "CREATE_DW_CODE_LOCATION", "dw_code_locations", {
      id: created.id,
      organizationUnitId: created.organizationUnitId,
      prefix: created.prefix,
    });
    return NextResponse.json({ success: true, location: created });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("dw_code_location_org_unit_uq")) {
      return NextResponse.json({ error: "Đơn vị này đã có cấu hình Mã số công nhật." }, { status: 409 });
    }
    if (message.includes("dw_code_location_prefix_uq")) {
      return NextResponse.json({ error: "Prefix này đã được dùng cho địa điểm khác." }, { status: 409 });
    }
    return NextResponse.json({ error: "Lỗi hệ thống: " + message }, { status: 500 });
  }
}
