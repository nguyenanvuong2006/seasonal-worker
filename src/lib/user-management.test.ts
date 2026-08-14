import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_PASSWORD_LENGTH,
  PROTECTION_ERRORS,
  buildPatch,
  changedFields,
  isRole,
  lastActiveAdminError,
  selectAuditAction,
  selfProtectionError,
  shouldBumpSessionVersion,
  validatePassword,
  type UserSnapshot,
} from "./user-management.ts";

function snap(id: string, overrides: Partial<UserSnapshot> = {}): UserSnapshot {
  return {
    id,
    username: id,
    fullName: id,
    role: "DEPT_MANAGER",
    deptId: null,
    isActive: true,
    ...overrides,
  };
}

function admin(id: string, overrides: Partial<UserSnapshot> = {}): UserSnapshot {
  return snap(id, { role: "ADMIN", ...overrides });
}

/* ============ Edit: fullName / role / department ============ */

test("Edit fullName — patch đúng field, không bump sessionVersion", () => {
  const target = snap("u1");
  const change = { fullName: "Nguyễn Văn A" };
  const { patch, password } = buildPatch(change);
  assert.equal(patch.fullName, "Nguyễn Văn A");
  assert.equal(password, null);
  assert.equal(shouldBumpSessionVersion(target, change), false);
  assert.equal(selectAuditAction(target, change), "UPDATE_USER");
  assert.deepEqual(changedFields(target, change), ["fullName"]);
});

test("Edit role — bump sessionVersion + action UPDATE_USER", () => {
  const target = snap("u1", { role: "HR_RECRUITER" });
  const change = { role: "DEPT_MANAGER" };
  const { patch } = buildPatch(change);
  assert.equal(patch.role, "DEPT_MANAGER");
  assert.equal(shouldBumpSessionVersion(target, change), true);
  assert.equal(selectAuditAction(target, change), "UPDATE_USER");
  assert.deepEqual(changedFields(target, change), ["role"]);
});

test("Edit department — patch deptId, không bump sessionVersion", () => {
  const target = snap("u1", { role: "DEPT_MANAGER", deptId: "d-1" });
  const change = { deptId: "d-2" };
  const { patch } = buildPatch(change);
  assert.equal(patch.deptId, "d-2");
  assert.equal(shouldBumpSessionVersion(target, change), false);
  assert.deepEqual(changedFields(target, change), ["deptId"]);
});

test("Đổi role ra khỏi DEPT_MANAGER -> buộc deptId = null (không để scope rác)", () => {
  const target = snap("u1", { role: "DEPT_MANAGER", deptId: "d-1" });
  const change = { role: "HR_RECRUITER", deptId: "d-1" };
  const { patch } = buildPatch(change);
  assert.equal(patch.role, "HR_RECRUITER");
  assert.equal(patch.deptId, null);
});

/* ============ Lock / Reactivate / Reset password / Delete ============ */

test("Lock normal user — isActive=false, bump, action DEACTIVATE_USER", () => {
  const target = snap("u1");
  const change = { isActive: false };
  const { patch } = buildPatch(change);
  assert.equal(patch.isActive, false);
  assert.equal(shouldBumpSessionVersion(target, change), true);
  assert.equal(selectAuditAction(target, change), "DEACTIVATE_USER");
  assert.deepEqual(changedFields(target, change), ["isActive"]);
});

test("Reactivate normal user — action ACTIVATE_USER, bump sessionVersion", () => {
  const target = snap("u1", { isActive: false });
  const change = { isActive: true };
  const { patch } = buildPatch(change);
  assert.equal(patch.isActive, true);
  assert.equal(selectAuditAction(target, change), "ACTIVATE_USER");
  assert.equal(shouldBumpSessionVersion(target, change), true);
  assert.deepEqual(changedFields(target, change), ["isActive"]);
});

test("Reset password — action RESET_USER_PASSWORD, KHÔNG bao giờ log giá trị mật khẩu", () => {
  const target = snap("u1");
  const secret = "super-secret-123";
  const change = { password: secret };
  const { patch, password } = buildPatch(change);
  assert.equal(password, secret);
  assert.equal("passwordHash" in patch, false); // hash được tính ở route, không nằm trong patch thô
  assert.equal(shouldBumpSessionVersion(target, change), true);
  assert.equal(selectAuditAction(target, change), "RESET_USER_PASSWORD");
  assert.deepEqual(changedFields(target, change), ["passwordHash"]); // chỉ tên field, không phải giá trị
  assert.ok(!changedFields(target, change).some((f) => f.includes(secret)));
});

test("Delete normal user — action DELETE_USER, bump sessionVersion (soft delete)", () => {
  const target = snap("u1");
  const change = { deleting: true };
  assert.equal(selectAuditAction(target, change), "DELETE_USER");
  assert.equal(shouldBumpSessionVersion(target, change), true);
  assert.equal(selfProtectionError("actor-admin", target, change), null); // xoá NGƯỜI KHÁC được phép
});

/* ============ Self-protection (bắt buộc backend) ============ */

test("Self-lock -> bị chặn", () => {
  const target = admin("me");
  assert.equal(selfProtectionError("me", target, { isActive: false }), PROTECTION_ERRORS.SELF_DEACTIVATE);
});

test("Self-delete -> bị chặn", () => {
  const target = admin("me");
  assert.equal(selfProtectionError("me", target, { deleting: true }), PROTECTION_ERRORS.SELF_DELETE);
});

test("Self-demote ADMIN -> bị chặn", () => {
  const target = admin("me");
  assert.equal(selfProtectionError("me", target, { role: "DEPT_MANAGER" }), PROTECTION_ERRORS.SELF_DEMOTE);
  // Giữ nguyên role ADMIN cho chính mình thì KHÔNG phải hạ quyền -> được phép.
  assert.equal(selfProtectionError("me", target, { role: "ADMIN" }), null);
});

test("Không phải chính mình -> không kích hoạt self-protection", () => {
  const target = admin("other");
  assert.equal(selfProtectionError("me", target, { isActive: false }), null);
  assert.equal(selfProtectionError("me", target, { deleting: true }), null);
  assert.equal(selfProtectionError("me", target, { role: "HR_RECRUITER" }), null);
});

/* ============ Last-active-ADMIN protection (bắt buộc backend) ============ */

test("Lock last active ADMIN -> bị chặn", () => {
  const only = [admin("a")];
  assert.equal(
    lastActiveAdminError(only, { id: "a", role: "ADMIN", isActive: true }, { isActive: false }),
    PROTECTION_ERRORS.LAST_ACTIVE_ADMIN,
  );
});

test("Delete last active ADMIN -> bị chặn", () => {
  const only = [admin("a")];
  assert.equal(
    lastActiveAdminError(only, { id: "a", role: "ADMIN", isActive: true }, { deleting: true }),
    PROTECTION_ERRORS.LAST_ACTIVE_ADMIN,
  );
});

test("Demote last active ADMIN -> bị chặn", () => {
  const only = [admin("a")];
  assert.equal(
    lastActiveAdminError(only, { id: "a", role: "ADMIN", isActive: true }, { role: "HR_RECRUITER" }),
    PROTECTION_ERRORS.LAST_ACTIVE_ADMIN,
  );
});

test("Còn 1 ADMIN khác đang active -> được phép khoá/xoá/hạ quyền", () => {
  const two = [admin("a"), admin("b")];
  assert.equal(lastActiveAdminError(two, { id: "a", role: "ADMIN", isActive: true }, { isActive: false }), null);
  assert.equal(lastActiveAdminError(two, { id: "a", role: "ADMIN", isActive: true }, { deleting: true }), null);
  assert.equal(lastActiveAdminError(two, { id: "a", role: "ADMIN", isActive: true }, { role: "HR_RECRUITER" }), null);
});

test("Không nhắm vào ADMIN active -> không áp dụng last-admin check", () => {
  const only = [admin("a")];
  assert.equal(lastActiveAdminError(only, { id: "m", role: "DEPT_MANAGER", isActive: true }, { isActive: false }), null);
  assert.equal(lastActiveAdminError(only, { id: "a", role: "ADMIN", isActive: false }, { deleting: true }), null);
});

/* ============ Session invalidation ============ */

test("Session invalidation: bump khi khoá/reset/đổi role, KHÔNG bump khi sửa tên/bộ phận", () => {
  const target = snap("u1");
  assert.equal(shouldBumpSessionVersion(target, { isActive: false }), true);
  assert.equal(shouldBumpSessionVersion(target, { password: "12345678" }), true);
  assert.equal(shouldBumpSessionVersion(target, { role: "HR_RECRUITER" }), true);
  assert.equal(shouldBumpSessionVersion(target, { deleting: true }), true);
  assert.equal(shouldBumpSessionVersion(target, { fullName: "Tên mới" }), false);
  assert.equal(shouldBumpSessionVersion(target, { deptId: "d-9" }), false);
  assert.equal(shouldBumpSessionVersion(target, { role: "DEPT_MANAGER" }), false); // cùng role -> không bump
});

/* ============ Policy mật khẩu + role validation ============ */

test("Password policy tối thiểu 8 ký tự, đồng nhất create/reset", () => {
  assert.equal(validatePassword("1234567"), `Mật khẩu tối thiểu ${MIN_PASSWORD_LENGTH} ký tự.`);
  assert.equal(validatePassword("12345678"), null);
  assert.equal(validatePassword("mật-khẩu-dài-hơn-8"), null);
  assert.equal(MIN_PASSWORD_LENGTH, 8);
});

test("Role không hợp lệ bị loại khỏi patch; isRole() kiểm tra đúng", () => {
  assert.equal(isRole("ADMIN"), true);
  assert.equal(isRole("HR_RECRUITER"), true);
  assert.equal(isRole("DEPT_MANAGER"), true);
  assert.equal(isRole("HACKER"), false);
  const { patch } = buildPatch({ role: "HACKER" });
  assert.equal(patch.role, undefined);
});

test("Audit action ưu tiên đúng thứ tự (delete > reset pw > lock/unlock > update)", () => {
  const target = snap("u1");
  assert.equal(selectAuditAction(target, { deleting: true, password: "12345678" }), "DELETE_USER");
  assert.equal(selectAuditAction(target, { password: "12345678", isActive: false }), "RESET_USER_PASSWORD");
  assert.equal(selectAuditAction(target, { isActive: false, fullName: "X" }), "DEACTIVATE_USER");
  assert.equal(selectAuditAction(snap("u1", { isActive: false }), { isActive: true, fullName: "X" }), "ACTIVATE_USER");
  assert.equal(selectAuditAction(target, { fullName: "X" }), "UPDATE_USER");
});
