import { NextResponse } from "next/server";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { createSession, verifyPassword, writeAudit, type Role } from "@/lib/auth";
import { isRoleActive } from "@/lib/rbac";
import { ensureSeed } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * P1-6 (Production Hardening Audit) — chống brute-force theo (IP + username), sliding window
 * 15 phút. Đếm/lưu vào `audit_logs` (bảng đã có sẵn) thay vì thêm bảng/dịch vụ ngoài mới.
 * GIỚI HẠN CẦN BIẾT: Vercel serverless không có bộ nhớ dùng chung giữa các instance — 1 bộ đếm
 * in-memory sẽ gần như vô nghĩa (mỗi cold start / mỗi instance có bộ nhớ riêng, request có thể
 * rơi vào instance khác nhau). Postgres (đã dùng cho toàn bộ app) LÀ state dùng chung thật sự
 * duy nhất hiện có mà không cần thêm Redis/dịch vụ trả phí — đánh đổi là 1 query nhỏ thêm cho
 * MỖI lần login (rẻ, có thể lọc theo index `action`/`created_at` nếu cần tối ưu thêm sau này).
 * Đếm theo (IP + username) — KHÔNG khoá theo IP một mình (tránh 1 mạng NAT/wifi công cộng khoá
 * nhầm người khác đang đăng nhập đúng username của họ — "dễ gây global lockout").
 */
async function recentFailedAttempts(ip: string, username: string): Promise<number> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60000);
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, "LOGIN_FAILED"),
        gte(auditLogs.createdAt, since),
        sql`${auditLogs.details}->>'ip' = ${ip}`,
        sql`${auditLogs.details}->>'username' = ${username}`,
      ),
    );
  return row?.c ?? 0;
}

async function recordFailedAttempt(ip: string, username: string) {
  try {
    await db.insert(auditLogs).values({
      action: "LOGIN_FAILED",
      targetType: "users",
      category: "AUTH",
      details: { ip, username },
    });
  } catch {
    /* bookkeeping chống brute-force không bao giờ được làm hỏng luồng đăng nhập chính */
  }
}

export async function POST(req: Request) {
  try {
    await ensureSeed();
    const { username, password } = await req.json();
    if (!username || !password) {
      return NextResponse.json({ error: "Vui lòng nhập đủ thông tin." }, { status: 400 });
    }
    const normalizedUsername = String(username).trim().toLowerCase();
    const ip = clientIp(req);

    const failedCount = await recentFailedAttempts(ip, normalizedUsername);
    if (failedCount >= MAX_FAILED_ATTEMPTS) {
      return NextResponse.json(
        { error: "Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ít phút." },
        { status: 429 },
      );
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, normalizedUsername))
      .limit(1);

    // Thông báo GIỐNG HỆT nhau dù sai username hay sai password hay tài khoản bị khoá — không
    // để lộ username có tồn tại trong hệ thống hay không.
    if (!user || !user.isActive || !verifyPassword(String(password), user.passwordHash)) {
      await recordFailedAttempt(ip, normalizedUsername);
      return NextResponse.json(
        { error: "Sai tên đăng nhập hoặc mật khẩu." },
        { status: 401 },
      );
    }

    // DYNAMIC RBAC V2 — vai trò bị TẮT (roles.is_active=false) thì chặn đăng nhập (mục J:
    // disable role đã bump session_version khiến phiên cũ hết hạn; chặn thêm ở login).
    if (!(await isRoleActive(user.role))) {
      return NextResponse.json({ error: "Vai trò của tài khoản đã bị vô hiệu hoá. Liên hệ quản trị viên." }, { status: 403 });
    }

    await createSession({
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      role: user.role as Role,
      deptId: user.deptId,
      sessionVersion: user.sessionVersion,
    });

    await writeAudit(
      { id: user.id, username: user.username, fullName: user.fullName, role: user.role as Role, deptId: user.deptId },
      "LOGIN",
      "users",
      { id: user.id },
    );

    // WORKFLOW TIẾP NHẬN — TÁCH VAI TRÒ (mục XIV): mỗi vai trò nghiệp vụ mới landing
    // thẳng vào màn việc chính của mình thay vì Task Center chung chung.
    const ROLE_HOME: Record<string, string> = {
      DEPT_MANAGER: "/department",
      HR_DIRECTOR: "/admin/dashboard",
      HR_SUPPORT: "/admin/document-merge",
      ADMINISTRATION: "/administration/daily-code",
      FINGERPRINT_STAFF: "/fingerprint/it-code",
      MEAL_STAFF: "/meal/export",
    };
    const redirect = ROLE_HOME[user.role] ?? "/task-center";

    return NextResponse.json({ success: true, role: user.role, redirect });
  } catch (error) {
    return NextResponse.json(
      { error: "Lỗi hệ thống: " + (error as Error).message },
      { status: 500 },
    );
  }
}
