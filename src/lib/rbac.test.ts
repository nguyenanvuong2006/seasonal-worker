import assert from "node:assert/strict";
import test from "node:test";
import {
  BASELINE_ROLE_PERMISSIONS,
  BASELINE_ROLE_KEYS,
  ENFORCED_PERMISSION_KEYS,
  LEGACY_PERMISSION_KEY_MAP,
  LEGACY_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  PERMISSION_GROUPS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_KEYS,
  getCatalogPermission,
  permissionLabel,
  roleLabel,
} from "./rbac-catalog.ts";

const allKeys = PERMISSION_CATALOG.map((p) => p.key);

test("catalog: ~42 permissions, mỗi key duy nhất", () => {
  assert.ok(allKeys.length >= 40 && allKeys.length <= 45, `expected ~43 permissions, got ${allKeys.length}`);
  assert.equal(new Set(allKeys).size, allKeys.length, "permission keys must be unique");
});

test("catalog: mỗi permission thuộc đúng 1 nhóm đã khai báo", () => {
  const groupKeys = new Set(PERMISSION_GROUPS.map((g) => g.key));
  assert.equal(groupKeys.size, PERMISSION_GROUPS.length, "group keys must be unique");
  assert.equal(PERMISSION_GROUPS.length, 15, "15 nhóm quyền mặc định (mục F)");
  for (const p of PERMISSION_CATALOG) {
    assert.ok(groupKeys.has(p.group), `permission ${p.key} has unknown group ${p.group}`);
  }
});

test("catalog: mọi baseline role đều tồn tại và baseline keys ⊆ catalog", () => {
  const roleKeys = new Set(SYSTEM_ROLE_KEYS);
  for (const roleKey of BASELINE_ROLE_KEYS) {
    assert.ok(roleKeys.has(roleKey), `baseline role ${roleKey} missing from SYSTEM_ROLES`);
  }
  const catalogKeys = new Set(allKeys);
  for (const [role, keys] of Object.entries(BASELINE_ROLE_PERMISSIONS)) {
    for (const k of keys) {
      assert.ok(catalogKeys.has(k), `baseline ${role} references unknown permission ${k}`);
    }
  }
});

test("catalog: ADMIN baseline = toàn bộ catalog (bypass cứng song song)", () => {
  assert.equal(BASELINE_ROLE_PERMISSIONS.ADMIN.length, allKeys.length);
});

test("catalog: ENFORCED_PERMISSION_KEYS = toàn bộ catalog (fail-closed)", () => {
  for (const k of allKeys) assert.ok(ENFORCED_PERMISSION_KEYS.has(k), `${k} must be enforced`);
});

test("catalog: mọi key legacy map đều trỏ tới key có trong catalog", () => {
  const catalogKeys = new Set(allKeys);
  for (const [legacy, targets] of Object.entries(LEGACY_PERMISSION_KEY_MAP)) {
    assert.ok(LEGACY_PERMISSION_KEYS.includes(legacy), `${legacy} must be listed in LEGACY_PERMISSION_KEYS`);
    assert.ok(targets.length > 0, `${legacy} must map to >= 1 new key`);
    for (const t of targets) assert.ok(catalogKeys.has(t), `${legacy} -> ${t} not in catalog`);
  }
});

test("HR_DIRECTOR (mục G): business authority — có hồ sơ/planning/workforce/export/audit; KHÔNG quản trị", () => {
  const d = new Set(BASELINE_ROLE_PERMISSIONS.HR_DIRECTOR);
  for (const allowed of ["registrations.view", "registrations.export", "dw.view", "worker_profile.view", "planning.view", "workforce_movements.view", "history.view", "audit.view", "dashboard.view", "global_search.use"]) {
    assert.ok(d.has(allowed), `HR_DIRECTOR must have ${allowed}`);
  }
  for (const denied of ["users.manage", "rbac.manage", "data_scope.manage", "backup.manage", "branding.manage", "system.view", "users.view", "import.run"]) {
    assert.ok(!d.has(denied), `HR_DIRECTOR must NOT have ${denied}`);
  }
});

test("DEPT_MANAGER (mục I): planning.request DRAFT-only, KHÔNG export/PII", () => {
  const m = new Set(BASELINE_ROLE_PERMISSIONS.DEPT_MANAGER);
  assert.ok(m.has("planning.request"));
  assert.ok(!m.has("planning.activate") && !m.has("planning.edit"), "manager không kích hoạt/sửa planning");
  assert.ok(!m.has("registrations.export"), "manager không export (Phase 10 tightening)");
  assert.ok(!m.has("privacy.view_cccd") && !m.has("privacy.view_phone"), "manager không xem PII");
  assert.ok(!m.has("workforce_movements.manage"), "manager không xử lý yêu cầu");
});

test("HR_RECRUITER: giữ đủ quyền vận hành hiện có", () => {
  const h = new Set(BASELINE_ROLE_PERMISSIONS.HR_RECRUITER);
  for (const k of ["registrations.view", "registrations.edit", "registrations.approve", "registrations.export", "dw.view", "dw.edit", "worker_profile.view", "planning.view", "planning.request", "planning.edit", "planning.activate", "workforce_movements.manage", "history.view", "history.restore", "dashboard.view"]) {
    assert.ok(h.has(k), `HR_RECRUITER must have ${k}`);
  }
  assert.ok(!h.has("users.manage") && !h.has("rbac.manage") && !h.has("backup.manage"), "HR không quản trị hệ thống");
});

test("helpers: label lookup có fallback an toàn", () => {
  assert.equal(roleLabel("ADMIN"), "Quản trị viên hệ thống");
  assert.equal(roleLabel("HR_DIRECTOR"), "Giám đốc Nhân sự");
  assert.equal(roleLabel("VAI_TRO_KHONG_TON_TAI"), "VAI_TRO_KHONG_TON_TAI");
  assert.equal(permissionLabel("registrations.view"), "Xem Daily Application");
  assert.equal(getCatalogPermission("registrations.view")?.group, "tuyendung");
});
