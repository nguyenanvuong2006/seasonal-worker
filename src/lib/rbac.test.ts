import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

test("catalog: ~42-75 permissions, mỗi key duy nhất", () => {
  // Mục X (Workflow tiếp nhận — tách vai trò) thêm 7 quyền mới: dw.import_from_registration
  // + administration.daily_code.{view,submit} + fingerprint.{view,submit} + meal.{view,export}.
  // (KHÔNG có key ".edit" riêng — backend chỉ enforce ".submit", xem mục V blocker #5.)
  assert.ok(allKeys.length >= 40 && allKeys.length <= 75, `expected 40-75 permissions, got ${allKeys.length}`);
  assert.equal(new Set(allKeys).size, allKeys.length, "permission keys must be unique");
});

test("catalog: mỗi permission thuộc đúng 1 nhóm đã khai báo", () => {
  const groupKeys = new Set(PERMISSION_GROUPS.map((g) => g.key));
  assert.equal(groupKeys.size, PERMISSION_GROUPS.length, "group keys must be unique");
  // 17 nhóm gốc + 3 nhóm mới (mục X): hanh_chinh, van_tay, bao_com.
  assert.equal(PERMISSION_GROUPS.length, 20, "20 nhóm quyền mặc định (bao gồm document_merge + employment + workflow tiếp nhận)");
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

/* ============================================================
   CATALOG CONSISTENCY AUDIT (Batch Permission Editor bug: "planning.columns.
   manage" was live in the DB — inserted directly by a migration — and
   actively enforced by requirePermission()/hasPermission() call sites, but
   was NEVER added to PERMISSION_CATALOG. GET /api/admin/permissions reads
   the DB `permissions` table (so it displayed the toggle) while
   toggle/batch_update_permissions validated against getCatalogPermission()
   (which didn't know it) — a route could enforce a permission the catalog
   had no record of at all. This scans every ROUTE/SERVICE source file for
   every permission key literal actually passed to requirePermission()/
   hasPermission()/requireRoleAndPermission() and asserts each one exists in
   PERMISSION_CATALOG — the single canonical source GET and POST both read.
   A future migration or route that introduces a new enforced permission
   key without adding it here fails this test immediately, instead of
   surfacing as "Permission key không hợp lệ" the first time an admin tries
   to save it.
   ============================================================ */
test("catalog consistency: every permission key literal enforced by requirePermission()/hasPermission() in src/ exists in PERMISSION_CATALOG", () => {
  const srcDir = fileURLToPath(new URL("../", import.meta.url)); // .../src
  const catalogKeys = new Set(allKeys);
  const found = new Map<string, string>(); // key -> first file it was found in

  const CALL_PATTERNS = [
    /requirePermission\(\s*\[[^\]]*\]\s*,\s*"([a-zA-Z0-9_.]+)"/g,
    /requireRoleAndPermission\(\s*(?:\[[^\]]*\]|\.\.\.[A-Za-z0-9_]+)\s*,\s*"([a-zA-Z0-9_.]+)"/g,
    /hasPermission\(\s*[^,()]+\s*,\s*"([a-zA-Z0-9_.]+)"/g,
  ];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith(".test.ts")) continue;
      // rbac-catalog.ts/rbac.ts/auth.ts define these functions — their own
      // parameter names ("permissionKey") are not string literals and never
      // match; nothing to exclude specially there.
      const source = readFileSync(full, "utf8");
      for (const pattern of CALL_PATTERNS) {
        for (const m of source.matchAll(pattern)) {
          const key = m[1];
          if (!found.has(key)) found.set(key, full.slice(srcDir.length));
        }
      }
    }
  }
  walk(srcDir.replace(/\/$/, ""));

  assert.ok(found.size > 30, `sanity check: expected to find dozens of enforced permission keys, found ${found.size}`);

  const missing = [...found.entries()].filter(([key]) => !catalogKeys.has(key));
  assert.deepEqual(
    missing,
    [],
    `permission key(s) enforced in code but missing from PERMISSION_CATALOG: ${missing.map(([k, f]) => `${k} (${f})`).join(", ")}`,
  );
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

/* ============================================================
   WORKFLOW TIẾP NHẬN — TÁCH VAI TRÒ (mục II, III, X, XV)
   ------------------------------------------------------------
   Separation of duties: mỗi vai trò mới CHỈ có đúng quyền trách
   nhiệm của mình — không mặc định thừa hưởng quyền của vai trò khác.
   ============================================================ */

const SYSTEM_ADMIN_ONLY_KEYS = [
  "users.manage",
  "rbac.manage",
  "data_scope.manage",
  "backup.manage",
  "branding.manage",
  "system.view",
  "workflow.manage",
] as const;

test("ADMINISTRATION (mục II.3, XV): role nghiệp vụ hành chính — KHÁC ADMIN, không quản trị hệ thống", () => {
  assert.notEqual("ADMINISTRATION", "ADMIN");
  const a = new Set(BASELINE_ROLE_PERMISSIONS.ADMINISTRATION);
  assert.ok(a.has("administration.daily_code.view"));
  assert.ok(a.has("administration.daily_code.submit"));
  assert.ok(!a.has("administration.daily_code.edit"), "không có key .edit — backend chỉ enforce .submit");
  for (const k of SYSTEM_ADMIN_ONLY_KEYS) {
    assert.ok(!a.has(k), `ADMINISTRATION KHÔNG được có quyền quản trị hệ thống: ${k}`);
  }
  assert.ok(!a.has("users.view"), "ADMINISTRATION không mặc định quản lý user");
  assert.ok(!a.has("registrations.approve"), "ADMINISTRATION không xếp việc/duyệt hồ sơ");
});

test("HR_SUPPORT (mục II.2, XV): chỉ Document Merge — KHÔNG quyền Recruiter mặc định, không sửa mã công nhật", () => {
  const s = new Set(BASELINE_ROLE_PERMISSIONS.HR_SUPPORT);
  assert.ok(s.has("document_merge.view"));
  assert.ok(s.has("document_merge.execute"));
  assert.ok(s.has("document_merge.history.view"));
  for (const k of ["registrations.edit", "registrations.approve", "employment.assign", "dw.edit", "dw.import_from_registration", "administration.daily_code.submit"]) {
    assert.ok(!s.has(k), `HR_SUPPORT KHÔNG được có quyền Recruiter/Administration: ${k}`);
  }
});

test("FINGERPRINT_STAFF (mục II.4, XV): chỉ IT Code/Vân tay — không duyệt hồ sơ, không sửa DW toàn cục", () => {
  const f = new Set(BASELINE_ROLE_PERMISSIONS.FINGERPRINT_STAFF);
  assert.ok(f.has("fingerprint.view"));
  assert.ok(f.has("fingerprint.submit"));
  assert.ok(!f.has("fingerprint.edit"), "không có key .edit — backend chỉ enforce .submit");
  for (const k of ["registrations.approve", "dw.edit", "dw.delete", "administration.daily_code.submit"]) {
    assert.ok(!f.has(k), `FINGERPRINT_STAFF KHÔNG được có quyền: ${k}`);
  }
});

test("MEAL_STAFF (mục II.5, XV): chỉ xem/xuất báo cơm — không sửa hồ sơ, không IT Code, không mã công nhật, không PII mặc định", () => {
  const m = new Set(BASELINE_ROLE_PERMISSIONS.MEAL_STAFF);
  assert.ok(m.has("meal.view"));
  assert.ok(m.has("meal.export"));
  for (const k of [
    "registrations.edit",
    "registrations.approve",
    "fingerprint.submit",
    "administration.daily_code.submit",
    "dw.edit",
    "privacy.view_cccd",
    "privacy.view_phone",
    "privacy.view_address",
  ]) {
    assert.ok(!m.has(k), `MEAL_STAFF KHÔNG được có quyền: ${k}`);
  }
});

test("helpers: label lookup có fallback an toàn", () => {
  assert.equal(roleLabel("ADMIN"), "Quản trị viên hệ thống");
  assert.equal(roleLabel("HR_DIRECTOR"), "Giám đốc Nhân sự");
  assert.equal(roleLabel("VAI_TRO_KHONG_TON_TAI"), "VAI_TRO_KHONG_TON_TAI");
  assert.equal(permissionLabel("registrations.view"), "Xem Daily Application");
  assert.equal(getCatalogPermission("registrations.view")?.group, "tuyendung");
});
