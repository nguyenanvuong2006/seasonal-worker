import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { destroySession, getSession, hashPassword, verifyPassword, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Khớp policy đang dùng ở /api/users (P1-5 — Production Hardening Audit): tối thiểu 8 ký tự.
const MIN_PASSWORD_LENGTH = 8;

/**
 * Đổi mật khẩu của CHÍNH mình — bắt buộc xác thực mật khẩu hiện tại ở SERVER (không tin form đã
 * validate ở client). Đổi mật khẩu xong bump `sessionVersion` (đúng thiết kế P0-6 — session
 * revocation) để MỌI JWT đã ký trước đó (kể cả JWT của chính phiên đang gọi API này) hết hiệu lực
 * ngay — rồi chủ động xoá cookie phiên hiện tại, buộc đăng nhập lại bằng mật khẩu mới.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  const body = (await req.json()) as { currentPassword?: string; newPassword?: string; confirmPassword?: string };
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  const confirmPassword = String(body.confirmPassword ?? "");

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "Vui lòng nhập đầy đủ mật khẩu hiện tại và mật khẩu mới." }, { status: 400 });
  }
  if (newPassword !== confirmPassword) {
    return NextResponse.json({ error: "Mật khẩu mới nhập lại không khớp." }, { status: 400 });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Mật khẩu mới tối thiểu ${MIN_PASSWORD_LENGTH} ký tự.` }, { status: 400 });
  }

  const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, session.id)).limit(1);
  if (!row || !verifyPassword(currentPassword, row.passwordHash)) {
    return NextResponse.json({ error: "Mật khẩu hiện tại không đúng." }, { status: 400 });
  }

  await db
    .update(users)
    .set({ passwordHash: hashPassword(newPassword), sessionVersion: sql`${users.sessionVersion} + 1` })
    .where(eq(users.id, session.id));

  await writeAudit(session, "CHANGE_OWN_PASSWORD", "users", { id: session.id }, "AUTH");
  await destroySession();

  return NextResponse.json({ success: true, requireRelogin: true });
}
