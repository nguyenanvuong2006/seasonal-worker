import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { fieldDefinitions } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { invalidateFieldDefinitionsCache } from "@/lib/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(fieldDefinitions).orderBy(asc(fieldDefinitions.sortOrder));
  return NextResponse.json({ rows });
}

/** Thêm 1 trường dữ liệu tuỳ chỉnh mới (ví dụ 1 cột đặc thù chỉ dùng để import/export). */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "field_definitions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const body = await req.json();
    const fieldKey = String(body.fieldKey || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_");
    if (!fieldKey || !body.displayName || !body.groupName) {
      return NextResponse.json({ error: "Thiếu mã trường, tên hiển thị hoặc nhóm." }, { status: 400 });
    }

    const [row] = await db
      .insert(fieldDefinitions)
      .values({
        fieldKey,
        groupName: body.groupName,
        displayName: String(body.displayName),
        databaseField: String(body.databaseField || "custom_answers"),
        importColumnName: body.importColumnName || body.displayName,
        exportColumnName: body.exportColumnName || body.displayName,
        aliases: Array.isArray(body.aliases) ? body.aliases.map((a: string) => String(a).trim()).filter(Boolean) : [],
        fieldType: body.fieldType || "TEXT",
        required: Boolean(body.required),
        defaultValue: body.defaultValue || null,
        visible: body.visible === undefined ? true : Boolean(body.visible),
        editable: true,
        searchable: Boolean(body.searchable),
        sortable: Boolean(body.sortable),
        filterable: Boolean(body.filterable),
        exportable: body.exportable === undefined ? true : Boolean(body.exportable),
        importable: body.importable === undefined ? true : Boolean(body.importable),
        validationRule: body.validationRule || null,
        applyFrom: body.applyFrom || null,
        sortOrder: Number(body.sortOrder) || 100,
        isSystem: false, // trường do admin tự thêm — có thể xoá được
      })
      .returning();

    invalidateFieldDefinitionsCache();
    await writeAudit(guard.session, "CREATE_FIELD_DEFINITION", "field_definitions", { id: row.id, fieldKey });
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return NextResponse.json(
      { error: "Mã trường đã tồn tại hoặc dữ liệu sai: " + (error as Error).message },
      { status: 400 },
    );
  }
}

/** Sửa metadata 1 trường: đổi tên hiển thị, thêm alias, bật/tắt import/export/search/filter... */
export async function PATCH(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "field_definitions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of [
    "displayName",
    "importColumnName",
    "exportColumnName",
    "fieldType",
    "required",
    "defaultValue",
    "visible",
    "searchable",
    "sortable",
    "filterable",
    "exportable",
    "importable",
    "validationRule",
    "applyFrom",
    "sortOrder",
  ]) {
    if (k in body) patch[k] = body[k];
  }
  if ("aliases" in body) {
    patch.aliases = Array.isArray(body.aliases)
      ? body.aliases.map((a: string) => String(a).trim()).filter(Boolean)
      : [];
  }

  const [row] = await db.update(fieldDefinitions).set(patch).where(eq(fieldDefinitions.id, body.id)).returning();
  invalidateFieldDefinitionsCache();
  await writeAudit(guard.session, "UPDATE_FIELD_DEFINITION", "field_definitions", { id: body.id });
  return NextResponse.json({ success: true, row });
}

/** Chỉ xoá được trường do admin tự thêm (isSystem=false) — trường lõi không được xoá, chỉ ẩn (visible=false). */
export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "field_definitions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const [existing] = await db.select().from(fieldDefinitions).where(eq(fieldDefinitions.id, id));
  if (!existing) return NextResponse.json({ error: "Không tìm thấy trường." }, { status: 404 });
  if (existing.isSystem) {
    return NextResponse.json(
      { error: "Đây là trường lõi của hệ thống — không thể xoá, chỉ có thể ẩn (Hiển thị = tắt)." },
      { status: 400 },
    );
  }

  await db.delete(fieldDefinitions).where(eq(fieldDefinitions.id, id));
  invalidateFieldDefinitionsCache();
  await writeAudit(guard.session, "DELETE_FIELD_DEFINITION", "field_definitions", { id });
  return NextResponse.json({ success: true });
}
