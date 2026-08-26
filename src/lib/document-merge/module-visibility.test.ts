import test from "node:test";
import assert from "node:assert/strict";
import { canSeeTab, DOCUMENT_MERGE_PERMISSION_KEYS, firstPermittedTab, hasAnyDocumentMergePermission, TAB_PERMISSION } from "./module-visibility.ts";

/* ------------------------------------------------------------------ *
 * ISSUE B — Document Merge module visibility must be ANY-of, never
 * gated on document_merge.view as a parent/gateway permission.
 * ------------------------------------------------------------------ */

test("DOCUMENT_MERGE_PERMISSION_KEYS reads the canonical catalog directly — the 5 known keys, no duplication", () => {
  assert.deepEqual(
    [...DOCUMENT_MERGE_PERMISSION_KEYS].sort(),
    ["document_merge.execute", "document_merge.history.delete", "document_merge.history.view", "document_merge.templates.manage", "document_merge.view"].sort(),
  );
});

test("Regression test 1 — execute=true, view=false: module visible via hasAnyDocumentMergePermission, Merge tab accessible", () => {
  const permissions = new Set(["document_merge.execute"]);
  assert.equal(hasAnyDocumentMergePermission(permissions), true, "module must be visible");
  assert.equal(canSeeTab("merge", permissions, "HR_RECRUITER"), true, "Thực hiện Merge must be visible/accessible");
  assert.equal(canSeeTab("templates", permissions, "HR_RECRUITER"), false);
  assert.equal(canSeeTab("history", permissions, "HR_RECRUITER"), false);
  assert.equal(canSeeTab("fields", permissions, "HR_RECRUITER"), false, "Overview requiring .view must be hidden");
  assert.equal(firstPermittedTab(permissions, "HR_RECRUITER"), "merge", "landing must go straight to the one usable feature");
});

test("Regression test 2 — history.view=true, all others false: module visible, History visible, landing goes to History", () => {
  const permissions = new Set(["document_merge.history.view"]);
  assert.equal(hasAnyDocumentMergePermission(permissions), true);
  assert.equal(canSeeTab("history", permissions, "HR_SUPPORT"), true);
  assert.equal(canSeeTab("merge", permissions, "HR_SUPPORT"), false);
  assert.equal(canSeeTab("templates", permissions, "HR_SUPPORT"), false);
  assert.equal(firstPermittedTab(permissions, "HR_SUPPORT"), "history");
});

test("Regression test 3 — templates.manage=true, all others false: module visible, Templates accessible", () => {
  const permissions = new Set(["document_merge.templates.manage"]);
  assert.equal(hasAnyDocumentMergePermission(permissions), true);
  assert.equal(canSeeTab("templates", permissions, "HR_RECRUITER"), true);
  assert.equal(canSeeTab("pdfmapper", permissions, "HR_RECRUITER"), true, "PDF Mapper shares the same templates.manage-backed routes");
  assert.equal(canSeeTab("merge", permissions, "HR_RECRUITER"), false);
  assert.equal(firstPermittedTab(permissions, "HR_RECRUITER"), "templates");
});

test("Regression test 4 — all document_merge.* = false: module hidden", () => {
  const permissions = new Set<string>();
  assert.equal(hasAnyDocumentMergePermission(permissions), false);
  for (const key of DOCUMENT_MERGE_PERMISSION_KEYS as string[]) {
    assert.equal(permissions.has(key), false);
  }
  assert.equal(firstPermittedTab(permissions, "HR_RECRUITER"), null, "no non-ADMIN landing destination exists");
});

test("Regression test 5 — history.delete=false: the delete control's own permission is independently false even though history.view is granted (UI must hide/disable it)", () => {
  const permissions = new Set(["document_merge.history.view"]);
  assert.equal(permissions.has("document_merge.history.delete"), false, "history tab visible, but delete-capability flag is false — component must hide/disable the Xóa lịch sử control");
});

test("Regression test 6 — child frontend visibility matches the canonical permission set from the exact mission example (execute+history.view granted, rest false)", () => {
  const permissions = new Set(["document_merge.execute", "document_merge.history.view"]);
  const role = "HR_RECRUITER";
  assert.equal(hasAnyDocumentMergePermission(permissions), true, "Trộn tài liệu VISIBLE");
  assert.equal(canSeeTab("merge", permissions, role), true, "Thực hiện Merge VISIBLE");
  assert.equal(canSeeTab("history", permissions, role), true, "Lịch sử Merge VISIBLE");
  assert.equal(permissions.has("document_merge.history.delete"), false, "Xóa lịch sử HIDDEN/DISABLED");
  assert.equal(canSeeTab("templates", permissions, role), false, "Quản lý Templates HIDDEN");
  assert.equal(canSeeTab("fields", permissions, role), false, "Overview requiring .view HIDDEN");
  assert.equal(firstPermittedTab(permissions, role), "merge", "landing priority: execute wins over history.view");
});

test("every TAB_PERMISSION value is a real key from the canonical catalog (no drift between the tab map and the catalog)", () => {
  const catalogKeys = new Set(DOCUMENT_MERGE_PERMISSION_KEYS);
  for (const key of Object.values(TAB_PERMISSION)) {
    assert.ok(catalogKeys.has(key), `${key} must exist in DOCUMENT_MERGE_PERMISSION_KEYS`);
  }
});

test("verification tab is ADMIN-only regardless of permissions granted (mirrors the hard role gate on every verification/* backend route — not a permission-driven tab)", () => {
  const allPermissions = new Set(DOCUMENT_MERGE_PERMISSION_KEYS);
  assert.equal(canSeeTab("verification", allPermissions, "HR_RECRUITER"), false, "no permission grants verification access — only role ADMIN does, matching the backend");
  assert.equal(canSeeTab("verification", new Set(), "ADMIN"), true);
});

test("firstPermittedTab priority order: execute > history.view > templates.manage > view, when multiple are granted at once", () => {
  const role = "ADMIN";
  assert.equal(firstPermittedTab(new Set(["document_merge.execute", "document_merge.history.view", "document_merge.templates.manage", "document_merge.view"]), role), "merge");
  assert.equal(firstPermittedTab(new Set(["document_merge.history.view", "document_merge.templates.manage", "document_merge.view"]), role), "history");
  assert.equal(firstPermittedTab(new Set(["document_merge.templates.manage", "document_merge.view"]), role), "templates");
  assert.equal(firstPermittedTab(new Set(["document_merge.view"]), role), "fields");
});
