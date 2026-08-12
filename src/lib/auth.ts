import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, rolePermissions, userDepartmentScopes, type RolePermission } from "@/db/schema";

export type Role = "ADMIN" | "HR_RECRUITER" | "DEPT_MANAGER";

export type Session = {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  deptId: string | null;
};

const COOKIE_NAME = "hasfarm_session";

function secretKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is required");
  }
  return new TextEncoder().encode(secret);
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const candidate = scryptSync(plain, salt, 64);
    const original = Buffer.from(hash, "hex");
    if (candidate.length !== original.length) return false;
    return timingSafeEqual(candidate, original);
  } catch {
    return false;
  }
}

export async function createSession(session: Session) {
  const token = await new SignJWT({ ...session })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secretKey());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function getSession(): Promise<Session | null> {
  try {
    const store = await cookies();
    const token = store.get(COOKIE_NAME)?.value;
    if (!token) return null;
    const { payload } = await jwtVerify(token, secretKey());
    if (!payload || typeof payload.username !== "string") return null;
    return {
      id: String(payload.id),
      username: String(payload.username),
      fullName: String(payload.fullName),
      role: payload.role as Role,
      deptId: (payload.deptId as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/** Hard security: every protected API must call this. */
export async function requireRole(roles: Role[]): Promise<
  { ok: true; session: Session } | { ok: false; status: number; error: string }
> {
  const session = await getSession();
  if (!session) {
    return { ok: false, status: 401, error: "Chưa đăng nhập. Vui lòng đăng nhập lại." };
  }
  if (!roles.includes(session.role)) {
    return { ok: false, status: 403, error: "Từ chối truy cập! Quyền hạn không hợp lệ." };
  }
  return { ok: true, session };
}

/**
 * LOGGING (#12): 1 bảng audit_logs, phân loại bằng cột `category`.
 * Tự suy ra category từ tiền tố tên action để KHÔNG phải sửa lại hàng chục
 * lệnh gọi writeAudit() đang có sẵn trong code — chỉ nơi nào cần loại khác
 * (SYSTEM/API) mới cần truyền category rõ ràng ở tham số thứ 5.
 */
function inferCategory(action: string): "AUDIT" | "SYSTEM" | "IMPORT" | "EXPORT" | "AUTH" | "API" {
  if (action.startsWith("IMPORT")) return "IMPORT";
  if (action.startsWith("EXPORT")) return "EXPORT";
  if (action === "LOGIN" || action === "LOGOUT") return "AUTH";
  return "AUDIT";
}

export async function writeAudit(
  session: Session,
  action: string,
  targetType: string,
  details: Record<string, unknown>,
  category?: "AUDIT" | "SYSTEM" | "IMPORT" | "EXPORT" | "AUTH" | "API",
) {
  try {
    await db.insert(auditLogs).values({
      userId: session.id,
      username: session.username,
      action,
      targetType,
      category: category ?? inferCategory(action),
      details,
    });
  } catch {
    /* audit must never break the request */
  }
}

/* ============================================================
   RBAC CHI TIẾT (#11) — bổ sung SONG SONG với requireRole() theo Role.
   requireRole() vẫn là lớp bảo vệ CHÍNH cho mọi route (không đổi, để
   không phá hệ thống đang chạy). hasPermission() là lớp kiểm tra BỔ
   SUNG, dùng ở nơi cần bật/tắt 1 chức năng cụ thể cho 1 Role mà không
   cần đổi code (cấu hình tại /admin/permissions).
   Nếu bảng role_permissions chưa có dòng nào cho (role, key) → mặc
   định TRUE cho ADMIN, và TRUE cho HR_RECRUITER/DEPT_MANAGER nếu role
   đó đã qua được requireRole() của route (tức là không mặc định khoá
   ai khi admin chưa cấu hình gì — tránh tự khoá hệ thống của mình).
   ============================================================ */
let permCache: { at: number; rows: RolePermission[] } | null = null;
const PERM_CACHE_MS = 15_000;

async function loadPermissions(): Promise<RolePermission[]> {
  const now = Date.now();
  if (!permCache || now - permCache.at > PERM_CACHE_MS) {
    const rows = await db.select().from(rolePermissions);
    permCache = { at: now, rows };
  }
  return permCache.rows;
}

export function invalidatePermissionCache() {
  permCache = null;
}

export async function hasPermission(role: Role, permissionKey: string): Promise<boolean> {
  const rows = await loadPermissions();
  const row = rows.find((r) => r.role === role && r.permissionKey === permissionKey);
  if (row) return row.allowed;
  return true; // chưa cấu hình = không chặn (an toàn theo mặc định "mở" để không tự khoá hệ thống)
}

/* ============================================================
   DATA SCOPE (Phase 2, Step 1) — trả lời "được thao tác Ở ĐÂU", tách biệt
   khỏi Role ("được làm GÌ") và Permission ("được làm chức năng nào"). Dùng
   ở mọi nơi đang lọc dữ liệu theo department: thay
     eq(table.deptId, session.deptId)
   bằng
     inArray(table.deptId, await getUserScope(session))
   ADMIN luôn có scope = toàn bộ department (không cần cấu hình) — kiểm tra
   bằng cách trả về null (nghĩa là "không giới hạn", nơi gọi tự bỏ điều kiện
   lọc khi nhận null). HR_RECRUITER mặc định cũng KHÔNG giới hạn (đúng vai
   trò hiện có — xử lý toàn bộ hồ sơ, không riêng theo bộ phận) trừ khi admin
   chủ động gán scope cụ thể. DEPT_MANAGER: dùng user_department_scopes nếu
   có, dự phòng session.deptId cũ nếu chưa được gán (không tự khoá ai trong
   lúc chuyển đổi từ cột deptId đơn sang bảng scope nhiều-nhiều).
   ============================================================ */
export async function getUserScope(session: Session): Promise<string[] | null> {
  if (session.role === "ADMIN" || session.role === "HR_RECRUITER") return null; // không giới hạn

  const rows = await db
    .select({ departmentId: userDepartmentScopes.departmentId })
    .from(userDepartmentScopes)
    .where(eq(userDepartmentScopes.userId, session.id));

  if (rows.length > 0) return rows.map((r) => r.departmentId);
  return session.deptId ? [session.deptId] : []; // dự phòng cột deptId cũ; [] = không được xem gì
}

/**
 * RBAC (#7) — "Toàn bộ route chuyển sang hasPermission(). Không còn route chỉ
 * requireRole()". Đây là điểm vào DUY NHẤT mà mọi route admin nên dùng: vẫn
 * giữ nguyên hàng rào Role (không phá luồng đăng nhập hiện tại), CỘNG THÊM
 * bắt buộc qua hasPermission() — admin có thể tắt 1 quyền cụ thể cho 1 Role
 * tại /admin/permissions mà không cần sửa code route.
 */
export async function requireRoleAndPermission(
  roles: Role[],
  permissionKey: string,
): Promise<{ ok: true; session: Session } | { ok: false; status: number; error: string }> {
  const guard = await requireRole(roles);
  if (!guard.ok) return guard;
  const allowed = await hasPermission(guard.session.role, permissionKey);
  if (!allowed) {
    return { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." };
  }
  return guard;
}
