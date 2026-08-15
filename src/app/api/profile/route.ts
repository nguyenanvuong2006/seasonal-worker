import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { departments, users } from "@/db/schema";
import { getSession, writeAudit } from "@/lib/auth";
import { normalizePersonName } from "@/lib/person-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FULL_NAME_LENGTH = 160;

/** Hồ sơ cá nhân — chỉ dữ liệu của CHÍNH người đang đăng nhập, không nhận id từ client. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      role: users.role,
      deptId: users.deptId,
      deptName: departments.deptName,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(departments, eq(users.deptId, departments.id))
    .where(eq(users.id, session.id))
    .limit(1);

  if (!row) return NextResponse.json({ error: "Không tìm thấy tài khoản." }, { status: 404 });
  return NextResponse.json({ profile: { ...row, fullName: normalizePersonName(row.fullName) } });
}

/**
 * Tự sửa hồ sơ — CHỈ cho phép đổi `fullName`. Không nhận/áp dụng role, permissions, Data Scope,
 * deptId, isActive dù client có gửi lên — tự đổi các trường đó là lỗ hổng leo thang quyền, nên
 * route này CHỦ ĐỘNG bỏ qua mọi field khác ngoài fullName thay vì tin theo body.
 */
export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  const body = (await req.json()) as { fullName?: string };
  const fullName = normalizePersonName(body.fullName);
  if (!fullName) return NextResponse.json({ error: "Họ và tên không được để trống." }, { status: 400 });
  if (fullName.length > MAX_FULL_NAME_LENGTH) {
    return NextResponse.json({ error: `Họ và tên tối đa ${MAX_FULL_NAME_LENGTH} ký tự.` }, { status: 400 });
  }

  const [row] = await db.update(users).set({ fullName }).where(eq(users.id, session.id)).returning({ id: users.id, fullName: users.fullName });

  await writeAudit(session, "UPDATE_OWN_PROFILE", "users", { id: session.id });
  return NextResponse.json({ success: true, row });
}
