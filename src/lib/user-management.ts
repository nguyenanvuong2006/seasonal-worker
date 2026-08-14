/**
 * USER MANAGEMENT SAFETY — pure, framework-free decision logic.
 *
 * Tách toàn bộ quy tắc bảo vệ/kiểm tra khỏi route để:
 *  1. Route chỉ còn là "vỏ" mỏng (auth + DB), không chứa logic nghiệp vụ lặp.
 *  2. Logic có thể test TRỰC TIẾP bằng node:test mà không cần Next.js/DB
 *     (xem src/lib/user-management.test.ts).
 *
 * Module này KHÔNG import gì từ "server-only"/"next/*"/"@/db" — hoàn toàn thuần
 * TypeScript nên import được cả ở client lẫn server và trong test.
 */

export type UserRole = "ADMIN" | "HR_RECRUITER" | "DEPT_MANAGER";

export const ROLES: readonly UserRole[] = ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"];

/** Policy mật khẩu DUY NHẤT cho create + reset (khớp backend bootstrap, xem P1-5). */
export const MIN_PASSWORD_LENGTH = 8;

/** Error copy thân thiện — được dùng bởi backend (lớp bảo vệ CHÍNH) và frontend (chú thích). */
export const PROTECTION_ERRORS = {
  SELF_DEACTIVATE: "Bạn không thể tự khóa tài khoản đang đăng nhập.",
  SELF_DELETE: "Bạn không thể tự xóa tài khoản đang đăng nhập.",
  SELF_DEMOTE: "Bạn không thể tự hạ quyền Quản trị viên của chính mình.",
  LAST_ACTIVE_ADMIN: "Hệ thống phải luôn có ít nhất một Quản trị viên đang hoạt động.",
} as const;

/** Hình chiếu tối thiểu của 1 user cho các phép kiểm tra. */
export type UserSnapshot = {
  id: string;
  username: string;
  fullName: string;
  role: string;
  deptId: string | null;
  isActive: boolean;
};

/** Chỉ cần id/role/isActive cho phép kiểm tra "Admin cuối cùng". */
export type AdminSnapshot = Pick<UserSnapshot, "id" | "role" | "isActive">;

/** Ý định thay đổi do client gửi lên (PATCH/DELETE). `deleting` đánh dấu yêu cầu xoá. */
export type ChangeIntent = {
  fullName?: string;
  role?: string;
  deptId?: string | null;
  isActive?: boolean;
  password?: string;
  deleting?: boolean;
};

export type AuditAction =
  | "UPDATE_USER"
  | "ACTIVATE_USER"
  | "DEACTIVATE_USER"
  | "RESET_USER_PASSWORD"
  | "DELETE_USER";

export function isRole(v: unknown): v is UserRole {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

/** Trả về thông báo lỗi nếu mật khẩu không đạt policy, null nếu hợp lệ. */
export function validatePassword(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return `Mật khẩu tối thiểu ${MIN_PASSWORD_LENGTH} ký tự.`;
  }
  return null;
}

/**
 * BẢO VỆ CHÍNH ADMIN ĐANG ĐĂNG NHẬP (self-protection).
 * Từ chối: tự khoá (isActive=false), tự xoá, tự hạ quyền (đổi ADMIN -> khác ADMIN).
 * Trả về error nếu vi phạm, null nếu được phép.
 */
export function selfProtectionError(
  actorId: string,
  target: UserSnapshot,
  change: ChangeIntent,
): string | null {
  if (actorId !== target.id) return null;
  if (change.deleting) return PROTECTION_ERRORS.SELF_DELETE;
  if (change.role !== undefined && change.role !== "ADMIN") return PROTECTION_ERRORS.SELF_DEMOTE;
  if (change.isActive === false) return PROTECTION_ERRORS.SELF_DEACTIVATE;
  return null;
}

/**
 * BẢO VỆ ADMIN HOẠT ĐỘNG CUỐI CÙNG (server-side).
 * Khi khoá/xoá/hạ quyền 1 ADMIN đang active, phải còn ÍT NHẤT 1 ADMIN KHÁC đang active.
 * Trả về error nếu đây là Admin active cuối cùng, null nếu được phép.
 */
export function lastActiveAdminError(
  allUsers: AdminSnapshot[],
  target: AdminSnapshot,
  change: ChangeIntent,
): string | null {
  const isActiveAdmin = target.role === "ADMIN" && target.isActive;
  if (!isActiveAdmin) return null;

  const removesActiveAdmin =
    change.deleting === true ||
    change.isActive === false ||
    (change.role !== undefined && change.role !== "ADMIN");

  if (!removesActiveAdmin) return null;

  const otherActiveAdmin = allUsers.some(
    (u) => u.id !== target.id && u.role === "ADMIN" && u.isActive,
  );
  return otherActiveAdmin ? null : PROTECTION_ERRORS.LAST_ACTIVE_ADMIN;
}

/**
 * Có cần tăng `sessionVersion` (đăng xuất mọi phiên cũ) hay không?
 * Chỉ đúng khi thay đổi THẬT SỰ ảnh hưởng phiên: khoá/mở, đổi role, đổi mật khẩu, xoá mềm.
 */
export function shouldBumpSessionVersion(target: UserSnapshot, change: ChangeIntent): boolean {
  if (change.deleting) return true;
  if (change.isActive !== undefined && change.isActive !== target.isActive) return true;
  if (change.role !== undefined && change.role !== target.role) return true;
  if (change.password !== undefined && change.password !== "") return true;
  return false;
}

/** Tổng hợp các field thành patch DB an toàn (role không hợp lệ bị bỏ qua). */
export function buildPatch(
  change: ChangeIntent,
  roleValidator: (r: string) => boolean = isRole,
): {
  patch: Record<string, unknown>;
  password: string | null;
} {
  const patch: Record<string, unknown> = {};
  let password: string | null = null;

  if (change.fullName !== undefined) patch.fullName = change.fullName;
  if (change.role !== undefined && roleValidator(change.role)) patch.role = change.role;
  if (change.deptId !== undefined) {
    // Role mới (nếu có) KHÔNG phải DEPT_MANAGER -> buộc deptId = null (không để lại scope rác).
    const explicitlyNonManager = change.role !== undefined && change.role !== "DEPT_MANAGER";
    patch.deptId = explicitlyNonManager ? null : change.deptId || null;
  }
  if (change.isActive !== undefined) patch.isActive = change.isActive;
  if (change.password !== undefined && change.password !== "") password = change.password;

  return { patch, password };
}

/** Chọn action audit phù hợp cho 1 yêu cầu (ưu tiên: xoá > reset pw > khoá/mở > sửa). */
export function selectAuditAction(target: UserSnapshot, change: ChangeIntent): AuditAction {
  if (change.deleting) return "DELETE_USER";
  if (change.password !== undefined && change.password !== "") return "RESET_USER_PASSWORD";
  if (change.isActive !== undefined && change.isActive !== target.isActive) {
    return change.isActive ? "ACTIVATE_USER" : "DEACTIVATE_USER";
  }
  return "UPDATE_USER";
}

/**
 * Danh sách field THẬT SỰ thay đổi (để ghi vào audit details).
 * Mật khẩu chỉ được ghi bằng TÊN FIELD ("passwordHash"), KHÔNG BAO GIỜ ghi giá trị.
 */
export function changedFields(target: UserSnapshot, change: ChangeIntent): string[] {
  const fields: string[] = [];
  if (change.fullName !== undefined && change.fullName !== target.fullName) fields.push("fullName");
  if (change.role !== undefined && change.role !== target.role) fields.push("role");
  if (change.deptId !== undefined && (change.deptId || null) !== target.deptId) fields.push("deptId");
  if (change.isActive !== undefined && change.isActive !== target.isActive) fields.push("isActive");
  if (change.password !== undefined && change.password !== "") fields.push("passwordHash");
  return fields;
}
