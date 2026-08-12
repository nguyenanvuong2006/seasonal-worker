import { NextResponse } from "next/server";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, users } from "@/db/schema";
import { hashPassword, requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES = ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"];
// P1-5 (Production Hardening Audit) — chuẩn hoá 1 policy mật khẩu duy nhất cho create/reset,
// khớp với mức tối thiểu đã dùng ở bootstrap INITIAL_ADMIN_PASSWORD (trước đây route này cho
// phép 6 ký tự, thấp hơn bootstrap — không nhất quán).
const MIN_PASSWORD_LENGTH = 8;

export async function GET() {
  const guard = await requireRoleAndPermission(["ADMIN"], "users.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rows = await db
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
    .orderBy(asc(users.username));

  return NextResponse.json({ rows });
}

export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "users.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const body = await req.json();
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!/^[a-z0-9_.]{3,32}$/.test(username)) {
      return NextResponse.json(
        { error: "Tên đăng nhập 3-32 ký tự, chỉ chữ thường/số/dấu chấm/gạch dưới." },
        { status: 400 },
      );
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `Mật khẩu tối thiểu ${MIN_PASSWORD_LENGTH} ký tự.` }, { status: 400 });
    }
    if (!ROLES.includes(body.role)) {
      return NextResponse.json({ error: "Vai trò không hợp lệ." }, { status: 400 });
    }

    const [row] = await db
      .insert(users)
      .values({
        username,
        passwordHash: hashPassword(password),
        fullName: String(body.fullName || username),
        role: body.role,
        deptId: body.role === "DEPT_MANAGER" ? body.deptId || null : null,
      })
      .returning({ id: users.id, username: users.username });

    await writeAudit(guard.session, "CREATE_USER", "users", { id: row.id, username });
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return NextResponse.json(
      { error: "Tên đăng nhập đã tồn tại: " + (error as Error).message },
      { status: 400 },
    );
  }
}

export async function PATCH(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "users.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if ("fullName" in body) patch.fullName = body.fullName;
  if ("role" in body && ROLES.includes(body.role)) patch.role = body.role;
  if ("deptId" in body) patch.deptId = body.deptId || null;
  if ("isActive" in body) patch.isActive = Boolean(body.isActive);
  if (body.password) {
    if (String(body.password).length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `Mật khẩu tối thiểu ${MIN_PASSWORD_LENGTH} ký tự.` }, { status: 400 });
    }
    patch.passwordHash = hashPassword(String(body.password));
  }

  // P0-6 (Production Hardening Audit) — đổi role/khoá tài khoản/đổi mật khẩu đều phải làm mọi
  // JWT đã ký trước đó (session cũ) hết hiệu lực NGAY, không đợi hết hạn 12h — tăng
  // `sessionVersion` để getSession() (đọc DB mỗi request) từ chối token cũ ở lần gọi kế tiếp.
  if ("role" in patch || "isActive" in patch || "passwordHash" in patch) {
    patch.sessionVersion = sql`${users.sessionVersion} + 1`;
  }

  const [row] = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, body.id))
    .returning({ id: users.id, username: users.username });

  await writeAudit(guard.session, "UPDATE_USER", "users", { id: body.id });
  return NextResponse.json({ success: true, row });
}

export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "users.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });
  if (id === guard.session.id) {
    return NextResponse.json({ error: "Không thể tự xoá tài khoản đang đăng nhập." }, { status: 400 });
  }
  await db.delete(users).where(eq(users.id, id));
  await writeAudit(guard.session, "DELETE_USER", "users", { id });
  return NextResponse.json({ success: true });
}
