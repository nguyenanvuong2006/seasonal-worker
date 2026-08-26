import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, rolePermissions, userDepartmentScopes, users, type RolePermission } from "@/db/schema";
import { ENFORCED_PERMISSION_KEYS, PERMISSION_CATALOG } from "@/lib/rbac-catalog";
import { normalizePersonName } from "@/lib/person-name";

/**
 * DYNAMIC RBAC V2 — Role không còn là enum 3 giá trị hardcode. users.role (varchar) giữ nguyên
 * là role key; danh mục vai trò nằm ở bảng `roles` (+ baseline in-memory trong rbac-catalog).
 * Mọi chỗ so sánh chuỗi (vd session.role === "ADMIN") vẫn hoạt động; vai trò tuỳ chỉnh chỉ
 * cần có dòng trong roles + role_permissions là được.
 */
export type Role = string;

export const LEGACY_ROLES: readonly Role[] = ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"] as const;

export type Session = {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  deptId: string | null;
};

/** Session đầy đủ trước khi ký JWT — cần thêm sessionVersion tại thời điểm login (xem P0-6). */
export type SessionInput = Session & { sessionVersion: number };

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

export async function createSession(session: SessionInput) {
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

/**
 * P0-6 (Production Hardening Audit) — SESSION REVOCATION. JWT chỉ chứng minh "đã đăng nhập
 * đúng lúc ký" — không tự động phản ánh việc tài khoản bị khoá/xoá/đổi vai trò SAU đó (JWT vẫn
 * hợp lệ cho tới khi hết hạn 12h dù DB đã đổi). Mỗi lần gọi getSession() giờ đọc lại 1 dòng
 * `users` từ DB (theo id, có index PK) để xác nhận: (1) user còn tồn tại + `isActive`; (2)
 * `sessionVersion` trong token khớp với DB — nếu đổi mật khẩu/đổi role/khoá tài khoản đều tăng
 * `sessionVersion` (xem POST/PATCH /api/users), làm mọi JWT ký trước đó vô hiệu ngay, không cần
 * đợi hết hạn. role/deptId/fullName trả về LUÔN LẤY TỪ DB (không lấy từ payload JWT) — đổi role
 * có hiệu lực ngay ở request kế tiếp, không phải đợi bump version.
 * TRADEOFF: thêm 1 query (PK lookup, rẻ) cho MỌI request có gọi getSession() — chấp nhận được
 * ở quy mô hiện tại (vài trăm lượt/ngày) và đúng tinh thần "production-safe, ít phá kiến trúc"
 * (không cần thêm Redis/session store ngoài để cache việc này).
 */
export async function getSession(): Promise<Session | null> {
  try {
    const store = await cookies();
    const token = store.get(COOKIE_NAME)?.value;
    if (!token) return null;
    const { payload } = await jwtVerify(token, secretKey());
    if (!payload || typeof payload.id !== "string") return null;

    const [user] = await db
      .select({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        role: users.role,
        deptId: users.deptId,
        isActive: users.isActive,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, payload.id))
      .limit(1);

    if (!user || !user.isActive) return null;
    if (typeof payload.sessionVersion !== "number" || payload.sessionVersion !== user.sessionVersion) return null;

    return {
      id: user.id,
      username: user.username,
      fullName: normalizePersonName(user.fullName),
      role: user.role as Role,
      deptId: user.deptId,
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
   DYNAMIC RBAC V2 — PERMISSION CHECK (fail-closed + ADMIN bypass).
   ---------------------------------------------------------------
   Thay mô hình cũ "chưa cấu hình = mặc định CHO PHÉP (fail-open)" bằng
   FAIL-CLOSED: quyền nằm trong ENFORCED_PERMISSION_KEYS (toàn bộ catalog)
   mà role KHÔNG có dòng cấu hình → TỪ CHỐI. ADMIN luôn bypass (true) —
   không bao giờ tự khoá quản trị viên.
   Vai trò tuỳ chỉnh mới tạo: chưa có dòng role_permissions nào → bị
   chặn mọi quyền cho tới khi admin gán quyền (fail-closed đúng nghĩa).
   requireRole() vẫn là lớp bảo vệ CHÍNH đầu tiên (danh sách role cho
   phép ở từng route); hasPermission() là lớp bảo vệ THỨ HAI theo quyền.
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
  if (role === "ADMIN") return true; // ADMIN bypass — quyền tối cao, không bị chặn bởi cấu hình
  const rows = await loadPermissions();
  const row = rows.find((r) => r.role === role && r.permissionKey === permissionKey);
  if (row) return row.allowed;
  // FAIL-CLOSED: chưa cấu hình = TỪ CHỐI với mọi quyền được enforce (kể cả key không nằm
  // trong catalog — tránh lỗ hổng "quyền mới chưa ai cấu hình thì ai cũng qua").
  void ENFORCED_PERMISSION_KEYS;
  return false;
}

/** Tập quyền hiệu lực của 1 phiên (dùng cho sidebar/page render server-side). */
export async function getSessionPermissionKeys(session: Session): Promise<string[]> {
  if (session.role === "ADMIN") return PERMISSION_CATALOG.map((p) => p.key);
  const rows = await loadPermissions();
  const out: string[] = [];
  for (const p of PERMISSION_CATALOG) {
    const row = rows.find((r) => r.role === session.role && r.permissionKey === p.key);
    if (row ? row.allowed : false) out.push(p.key);
  }
  return out;
}

/* ============================================================
   DATA SCOPE (Phase 2, Step 1 + DYNAMIC RBAC V2) — trả lời "được thao tác
   Ở ĐÂU", tách biệt khỏi Role ("được làm GÌ") và Permission ("được làm chức
   năng nào"). Dùng ở mọi nơi đang lọc dữ liệu theo department: thay
     eq(table.deptId, session.deptId)
   bằng
     inArray(table.deptId, await getUserScope(session))
   Quy ước giá trị trả về (KHÔNG đổi so với trước, nơi gọi đã quen):
     - string[]  → CHỈ được thao tác trên các department trong danh sách.
     - []        → không được thấy gì (safety net).
     - null      → KHÔNG giới hạn (bỏ điều kiện lọc).
   DYNAMIC RBAC V2 — "role-independent": scope giờ ĐỌC user_department_scopes
   CHO MỌI VAI TRÒ trước (kể cả ADMIN/HR nếu admin chủ động gán — bảng scope
   độc lập vai trò), chỉ còn 1 nhánh fallback cuối khi user CHƯA được gán scope
   nào: mặc định [] = không thấy gì (safety net), TRỪ role nào được cấp quyền
   `data_scope.unrestricted` (baseline: ADMIN, HR_RECRUITER — giữ ĐÚNG hành vi
   cũ) thì null = không giới hạn. Mọi call site (export/registrations/planning/
   workforce/global-search/task-center) đã bỏ proxy `role === "DEPT_MANAGER"`
   và gọi thẳng hàm này.

   RBAC role-rename audit fix: nhánh fallback cuối TRƯỚC ĐÂY so sánh trực tiếp
   `session.role === "ADMIN" || session.role === "HR_RECRUITER"` — bất kỳ vai
   trò nào khác (kể cả vai trò đã được cấp `dw.view` toàn công ty, ví dụ
   "ADMINISTRATION") đều rơi vào [] và bị Daily Application hiển thị nhầm thành
   "Chế độ Quản lý bộ phận", dù vai trò đó không phải Department Manager — chỉ
   đơn giản là "không phải ADMIN, không phải HR_RECRUITER". Thay bằng
   hasPermission() để admin cấp `data_scope.unrestricted` cho BẤT KỲ vai trò
   nào cần mặc định không giới hạn, không cần sửa code, không phụ thuộc
   role.key/role.name cụ thể nào ngoài 2 vai trò legacy giữ nguyên hành vi.
   ============================================================ */
export async function getUserScope(session: Session): Promise<string[] | null> {
  const rows = await db
    .select({ departmentId: userDepartmentScopes.departmentId })
    .from(userDepartmentScopes)
    .where(eq(userDepartmentScopes.userId, session.id));

  if (rows.length > 0) return rows.map((r) => r.departmentId);

  // Không có scope tường minh nào: quyền `data_scope.unrestricted` (WHERE) phải được
  // xét TRƯỚC deptId cột cũ. `users.deptId` chỉ là vị trí phòng ban trên sơ đồ tổ
  // chức (ai thuộc phòng nào) — KHÔNG phải là một scope hạn chế được gán tường minh.
  // Trước đây nhánh deptId này chạy trước, nên bất kỳ role nào có deptId khác null
  // (ví dụ "ADMINISTRATION" / "C&B - Code DW" thuộc phòng C&B) đều bị coi là SCOPED
  // dù đã được cấp data_scope.unrestricted — DW Data (không có cột phòng ban để lọc)
  // từ chối luôn thay vì cho phép GLOBAL.
  if (await hasPermission(session.role, "data_scope.unrestricted")) return null;

  // Legacy fallback (chưa gán scope nào, không có unrestricted): deptId cột cũ → scope đơn.
  if (session.deptId) return [session.deptId];
  return [];
}

/**
 * RBAC (#7) — "Toàn bộ route chuyển sang hasPermission(). Không còn route chỉ
 * requireRole()". Đây là điểm vào DUY NHẤT mà mọi route admin nên dùng: vẫn
 * giữ nguyên hàng rào Role (không phá luồng đăng nhập hiện tại), CỘNG THÊM
 * bắt buộc qua hasPermission() — admin có thể tắt 1 quyền cụ thể cho 1 Role
 * tại /admin/permissions mà không cần sửa code route.
 */
/**
 * DYNAMIC RBAC V2 — điểm vào DUY NHẤT cho mọi route cần kiểm tra quyền chi tiết:
 *   1. Với 3 vai trò LEGACY (ADMIN/HR_RECRUITER/DEPT_MANAGER, ra đời TRƯỚC Dynamic
 *      RBAC — xem LEGACY_ROLES) — bắt buộc CẢ hai lớp: có mặt trong `roles` (mảng
 *      allowlist cứng của route, defense-in-depth cho 3 vai trò này) VÀ có dòng
 *      hasPermission() cho phép.
 *   2. Với MỌI vai trò khác (HR_DIRECTOR, HR_SUPPORT, ADMINISTRATION, vai trò do
 *      admin tự tạo, hoặc vai trò legacy vừa bị ĐỔI TÊN HIỂN THỊ nhưng vẫn giữ
 *      nguyên `key`) — KHÔNG bị chặn bởi mảng `roles` cứng đó; quyền truy cập của
 *      chúng do CHÍNH permissionKey quyết định. Đây đúng là bản chất Dynamic RBAC:
 *      admin tạo vai trò + gán quyền tại /admin/permissions là đủ, không cần sửa
 *      code route.
 *
 * SỰ CỐ ĐÃ SỬA (RBAC role-rename audit): bản cũ gọi requireRole(roles) TRƯỚC —
 * hàm này chặn CỨNG mọi vai trò không có tên trong mảng `roles`, không phân biệt
 * legacy/tuỳ chỉnh. Vì vậy đoạn code "vai trò tuỳ chỉnh không bị chặn ở lớp này"
 * bên dưới không BAO GIỜ chạy tới được — requireRole() đã trả 403 từ trước đó rồi.
 * Hậu quả: một vai trò như "ADMINISTRATION" (dù đã được cấp hasPermission(dw.view)
 * = true trong ma trận quyền) vẫn bị 403 ở bất kỳ route nào quên liệt kê đúng
 * "ADMINISTRATION" trong mảng `roles` — HOÀN TOÀN không liên quan gì đến việc
 * roles.name của vai trò đó có bị đổi tên hiển thị hay không (role.key không đổi).
 */
export async function requirePermission(
  roles: Role[],
  permissionKey: string,
): Promise<{ ok: true; session: Session } | { ok: false; status: number; error: string }> {
  const session = await getSession();
  if (!session) {
    return { ok: false, status: 401, error: "Chưa đăng nhập. Vui lòng đăng nhập lại." };
  }
  if (LEGACY_ROLES.includes(session.role) && !roles.includes(session.role)) {
    return { ok: false, status: 403, error: "Từ chối truy cập! Quyền hạn không hợp lệ." };
  }
  const allowed = await hasPermission(session.role, permissionKey);
  if (!allowed) {
    return { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." };
  }
  return { ok: true, session };
}

/** @deprecated Tên cũ — giữ alias để không phá các route đang dùng; dùng requirePermission() cho code mới. */
export async function requireRoleAndPermission(
  roles: Role[],
  permissionKey: string,
): Promise<{ ok: true; session: Session } | { ok: false; status: number; error: string }> {
  return requirePermission(roles, permissionKey);
}
