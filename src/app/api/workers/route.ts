import { NextResponse } from "next/server";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, dwData } from "@/db/schema";
import { requirePermission, writeAudit } from "@/lib/auth";
import { getFieldDefinitions } from "@/lib/metadata";
import { normalizePersonName } from "@/lib/person-name";
import { CCCD_ERROR_MESSAGE, isValidCccd } from "@/lib/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ánh xạ database_field (khai báo ở /admin/field-definitions) -> cột Drizzle thật của bảng dw_data.
// Chỉ những field text nào có mặt ở đây mới có thể được bật "Tìm kiếm" cho màn hình DW Data.
const DW_SEARCHABLE_COLUMNS = {
  full_name: dwData.fullName,
  cccd: dwData.cccd,
  phone: dwData.phone,
  code: dwData.code,
  it_code: dwData.itCode,
  place_of_issue: dwData.placeOfIssue,
  residential_address: dwData.residentialAddress,
  permanent_address: dwData.permanentAddress,
} as const;

/** Sheet "DW Data" — tra cứu & chỉnh sửa hồ sơ lao động chính thức */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const limit = Math.min(200, parseInt(url.searchParams.get("limit") || "50"));

  // METADATA ENGINE: cột nào được tìm kiếm do admin cấu hình ở /admin/field-definitions
  // (nhóm dw_data, searchable=true) — thêm/bớt cột tìm kiếm không cần sửa code, miễn là
  // cột đó có mặt trong DW_SEARCHABLE_COLUMNS ở trên.
  const defs = await getFieldDefinitions("dw_data");
  const searchableCols = defs
    .filter((d) => d.searchable)
    .map((d) => DW_SEARCHABLE_COLUMNS[d.databaseField as keyof typeof DW_SEARCHABLE_COLUMNS])
    .filter(Boolean);
  const cols = searchableCols.length > 0 ? searchableCols : [dwData.fullName, dwData.cccd, dwData.phone, dwData.code];

  const where = q ? and(isNull(dwData.deletedAt), or(...cols.map((c) => ilike(c, `%${q}%`)))) : isNull(dwData.deletedAt);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(dwData)
    .where(where);

  const rows = await db
    .select()
    .from(dwData)
    .where(where)
    .orderBy(desc(dwData.createdAt), asc(dwData.fullName))
    .limit(limit)
    .offset((page - 1) * limit);

  // Chuẩn hoá họ tên trước khi trả về UI (dữ liệu legacy có thể chưa chuẩn).
  return NextResponse.json({
    rows: rows.map((r) => ({ ...r, fullName: normalizePersonName(r.fullName) })),
    total,
    page,
    limit,
  });
}

export async function PATCH(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "dw.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const [before] = await db.select().from(dwData).where(eq(dwData.id, body.id));

  const patch: Record<string, unknown> = {};
  for (const k of [
    "code",
    "fullName",
    "gender",
    "bod",
    "phone",
    "permanentAddress",
    "residentialAddress",
    "profile",
    "note",
  ]) {
    if (k in body) patch[k] = body[k] || null;
  }
  if ("cccd" in body) {
    const c = String(body.cccd ?? "").trim();
    if (!isValidCccd(c)) return NextResponse.json({ error: CCCD_ERROR_MESSAGE }, { status: 400 });
    patch.cccd = c;
  }
  if ("isActive" in body) patch.isActive = Boolean(body.isActive);
  // Chuẩn hoá họ tên trước khi lưu (mọi điểm ghi mới đều lưu giá trị chuẩn hoá).
  if (typeof patch.fullName === "string") patch.fullName = normalizePersonName(patch.fullName);

  const [updated] = await db.update(dwData).set(patch).where(eq(dwData.id, body.id)).returning();
  if (!updated) return NextResponse.json({ error: "Không tìm thấy." }, { status: 404 });

  // Sửa CCCD sai → đồng bộ toàn bộ đơn đăng ký sang CCCD đúng
  if (body.cascadeCccd && body.oldCccd && patch.cccd) {
    await db
      .update(dailyApplications)
      .set({ cccd: String(patch.cccd), dwId: updated.id, dwMatch: "MATCHED", updatedAt: new Date() })
      .where(eq(dailyApplications.cccd, String(body.oldCccd)));
  }

  await writeAudit(guard.session, "UPDATE_DW_WORKER", "dw_data", {
    id: body.id,
    before: before ? Object.fromEntries(Object.keys(patch).map((k) => [k, (before as Record<string, unknown>)[k]])) : null,
    after: patch,
  });
  return NextResponse.json({ success: true, row: updated });
}

/** Xoá mềm — hồ sơ ẩn khỏi DW Data nhưng vẫn còn trong database, khôi phục tại /admin/recycle-bin. */
export async function DELETE(req: Request) {
  const guard = await requirePermission(["ADMIN"], "dw.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });
  await db
    .update(dwData)
    .set({ deletedAt: new Date(), deletedBy: guard.session.username })
    .where(and(eq(dwData.id, id), isNull(dwData.deletedAt)));
  await writeAudit(guard.session, "SOFT_DELETE_DW_WORKER", "dw_data", { id });
  return NextResponse.json({ success: true });
}
