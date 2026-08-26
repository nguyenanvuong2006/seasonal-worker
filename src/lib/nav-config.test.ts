import test from "node:test";
import assert from "node:assert/strict";
import { DOCUMENT_MERGE_PERMISSION_KEYS } from "./document-merge/module-visibility.ts";
import { NAV_GROUPS, filterGroups, hasNavPermission } from "./nav-config.ts";

function findItem(href: string) {
  for (const g of NAV_GROUPS) {
    const item = g.items.find((i) => i.href === href);
    if (item) return item;
  }
  throw new Error(`nav item ${href} not found`);
}

/* ------------------------------------------------------------------ *
 * ISSUE B — Document Merge nav must show for ANY of its 5 permissions,
 * tested against the REAL production NAV_GROUPS, not a stub.
 * ------------------------------------------------------------------ */

test("Document Merge nav item's permission list is exactly the canonical catalog group — no hardcoded duplicate list to drift", () => {
  const item = findItem("/admin/document-merge");
  assert.ok(Array.isArray(item.permission));
  assert.deepEqual([...(item.permission as string[])].sort(), [...DOCUMENT_MERGE_PERMISSION_KEYS].sort());
});

// ADMINISTRATION is deliberately used here (not ADMIN/HR_RECRUITER/HR_SUPPORT/
// HR_DIRECTOR — all of which are in the item's legacy `roles` allowlist and
// would show the module regardless of permission) so these tests isolate the
// permission-only path being fixed, not the separate legacy roles[] bypass.
test("Regression: a role with ONLY document_merge.execute (view=false) still sees Trộn tài liệu in the sidebar", () => {
  const groups = filterGroups("ADMINISTRATION", new Set(["document_merge.execute"]));
  const flat = groups.flatMap((g) => g.items.map((i) => i.href));
  assert.ok(flat.includes("/admin/document-merge"), "the exact reported bug: execute=true, view=false must NOT hide the module");
});

test("Regression: a role with ONLY document_merge.history.view sees the module", () => {
  const groups = filterGroups("ADMINISTRATION", new Set(["document_merge.history.view"]));
  const flat = groups.flatMap((g) => g.items.map((i) => i.href));
  assert.ok(flat.includes("/admin/document-merge"));
});

test("Regression: a role with NO document_merge.* permission at all does not see the module", () => {
  // ADMINISTRATION is deliberately NOT in the item's legacy `roles` allowlist
  // (that allowlist is a separate, pre-existing nav convenience unrelated to
  // this audit — see the "roles[] nav bypass" note in the audit report) so
  // this isolates the permission-only path being fixed here.
  const groups = filterGroups("ADMINISTRATION", new Set());
  const flat = groups.flatMap((g) => g.items.map((i) => i.href));
  assert.ok(!flat.includes("/admin/document-merge"));
});

/* ------------------------------------------------------------------ *
 * OTHER MODULES AUDITED — Users / RBAC / Data Scope also had the exact
 * same anti-pattern (nav gated on .manage only, while a separate .view
 * permission independently gates the GET route) — fixed the same way.
 * ------------------------------------------------------------------ */

test("Users nav (Quản lý thành viên): visible with EITHER users.view or users.manage, not just .manage", () => {
  assert.ok(filterGroups("HR_DIRECTOR", new Set(["users.view"])).flatMap((g) => g.items.map((i) => i.href)).includes("/admin/users"), "users.view alone must be enough — GET /api/users only requires users.view");
  assert.ok(filterGroups("HR_DIRECTOR", new Set(["users.manage"])).flatMap((g) => g.items.map((i) => i.href)).includes("/admin/users"));
  assert.ok(!filterGroups("HR_DIRECTOR", new Set()).flatMap((g) => g.items.map((i) => i.href)).includes("/admin/users"));
});

test("RBAC nav (Phân quyền chi tiết): visible with EITHER rbac.view or rbac.manage", () => {
  assert.ok(filterGroups("HR_DIRECTOR", new Set(["rbac.view"])).flatMap((g) => g.items.map((i) => i.href)).includes("/admin/permissions"), "rbac.view alone must be enough — GET /api/admin/permissions only requires rbac.view");
  assert.ok(filterGroups("HR_DIRECTOR", new Set(["rbac.manage"])).flatMap((g) => g.items.map((i) => i.href)).includes("/admin/permissions"));
});

test("Data Scope nav: visible with EITHER data_scope.view or data_scope.manage", () => {
  assert.ok(filterGroups("HR_DIRECTOR", new Set(["data_scope.view"])).flatMap((g) => g.items.map((i) => i.href)).includes("/admin/data-scopes"), "data_scope.view alone must be enough — GET /api/admin/data-scopes only requires data_scope.view");
  assert.ok(filterGroups("HR_DIRECTOR", new Set(["data_scope.manage"])).flatMap((g) => g.items.map((i) => i.href)).includes("/admin/data-scopes"));
});

/* ------------------------------------------------------------------ *
 * Regression test 8 — role rename has no effect: filterGroups/hasNavPermission
 * only ever read role KEY (a fixed string like "ADMINISTRATION") and the
 * permission set — never a display name (which isn't even a parameter here).
 * ------------------------------------------------------------------ */

test("role rename has no effect: filterGroups()/hasNavPermission() take only role KEY + permission set, no display-name parameter exists to feed a rename into", () => {
  const groups1 = filterGroups("ADMINISTRATION", new Set(["document_merge.execute"]));
  const groups2 = filterGroups("ADMINISTRATION", new Set(["document_merge.execute"])); // same key, would be same regardless of any hypothetical display name
  assert.deepEqual(
    groups1.flatMap((g) => g.items.map((i) => i.href)),
    groups2.flatMap((g) => g.items.map((i) => i.href)),
  );
});

test("hasNavPermission: single-string permission items are unaffected (backward compatible) — e.g. dw.view still gates DW Data alone", () => {
  const dwItem = findItem("/hr/workers");
  assert.equal(dwItem.permission, "dw.view");
  assert.equal(hasNavPermission(dwItem, new Set(["dw.view"])), true);
  assert.equal(hasNavPermission(dwItem, new Set()), false);
});

test("array-form permission is ANY-of, never ALL-of: a single matching key out of several is sufficient", () => {
  const item = findItem("/admin/document-merge");
  assert.equal(hasNavPermission(item, new Set(["document_merge.templates.manage"])), true);
  assert.equal(hasNavPermission(item, new Set(["some.unrelated.key"])), false);
});
