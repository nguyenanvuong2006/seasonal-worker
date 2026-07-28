import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, verifyPassword, writeAudit, type Role } from "@/lib/auth";
import { ensureSeed } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    await ensureSeed();
    const { username, password } = await req.json();
    if (!username || !password) {
      return NextResponse.json({ error: "Vui lòng nhập đủ thông tin." }, { status: 400 });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, String(username).trim().toLowerCase()))
      .limit(1);

    if (!user || !user.isActive || !verifyPassword(String(password), user.passwordHash)) {
      return NextResponse.json(
        { error: "Sai tên đăng nhập hoặc mật khẩu." },
        { status: 401 },
      );
    }

    await createSession({
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      role: user.role as Role,
      deptId: user.deptId,
    });

    await writeAudit(
      { id: user.id, username: user.username, fullName: user.fullName, role: user.role as Role, deptId: user.deptId },
      "LOGIN",
      "users",
      { id: user.id },
    );

    const redirect =
      user.role === "DEPT_MANAGER" ? "/department" : "/task-center";

    return NextResponse.json({ success: true, role: user.role, redirect });
  } catch (error) {
    return NextResponse.json(
      { error: "Lỗi hệ thống: " + (error as Error).message },
      { status: 500 },
    );
  }
}
