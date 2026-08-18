import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, eqValue, type FakeDb, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";
import * as orgTree from "./organization-tree.ts";

/* ============================================================
   PR1 — ORGANIZATION CANONICALIZATION & COVERAGE AUDIT
   ------------------------------------------------------------
   Kiểm thử ĐÚNG SOURCE THẬT của src/lib/organization-units.ts (không viết lại
   logic) qua fake-drizzle, cùng khuôn mẫu recruitment-kpi.test.ts:
     1. findOrganizationUnitByCode / findOrganizationUnitByLegacyDepartmentId /
        getLegacyDepartmentIdForUnit — EXACT MATCH, không fuzzy, ném lỗi rõ ràng
        khi dữ liệu mơ hồ thay vì đoán (mục XV/XVI/XVII đề bài).
     2. createOrganizationUnit — code collision check giờ xét TOÀN BỘ dòng (kể
        cả inactive), không chỉ dòng active — chặn "retired code reuse" (mục XI).
   ============================================================ */

const schemaStub = {
  organizationUnits: makeTable("organization_units"),
  departments: makeTable("departments"),
  employmentSessions: makeTable("employment_sessions"),
  dailyApplications: makeTable("daily_applications"),
  recruitmentRequests: makeTable("recruitment_requests"),
};

function load(db: FakeDb) {
  return loadModule(new URL("./organization-units.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/organization-tree": orgTree,
    },
  });
}

function unitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "unit-1",
    code: "packing",
    name: "Packing",
    unitType: "DEPARTMENT",
    parentId: "root-id",
    path: "root.packing",
    depth: 1,
    sortOrder: 0,
    isActive: true,
    legacyDepartmentId: null,
    createdAt: new Date("2026-08-17T00:00:00Z"),
    updatedAt: new Date("2026-08-17T00:00:00Z"),
    ...overrides,
  };
}

/* ------------------------------------------------------------
   findOrganizationUnitByCode — EXACT MATCH
   ------------------------------------------------------------ */

test("findOrganizationUnitByCode: không tìm thấy -> null", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);
  const fn = mod.findOrganizationUnitByCode as (code: string) => Promise<unknown>;
  assert.equal(await fn("khong-ton-tai"), null);
});

test("findOrganizationUnitByCode: rỗng/khoảng trắng -> null NGAY, không query DB", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);
  const fn = mod.findOrganizationUnitByCode as (code: string) => Promise<unknown>;
  assert.equal(await fn("   "), null);
  assert.equal(db.calls.length, 0);
});

test("findOrganizationUnitByCode: đúng 1 dòng active -> trả về dòng đó, isActive rõ ràng", async () => {
  const db = createFakeDb({ respond: () => [unitRow({ isActive: true })] });
  const mod = load(db);
  const fn = mod.findOrganizationUnitByCode as (code: string) => Promise<{ id: string; isActive: boolean } | null>;
  const result = await fn("packing");
  assert.equal(result?.id, "unit-1");
  assert.equal(result?.isActive, true);
});

test("findOrganizationUnitByCode: 1 active + nhiều inactive cùng code (lịch sử) -> ưu tiên trả dòng active", async () => {
  const db = createFakeDb({
    respond: () => [
      unitRow({ id: "old-inactive-1", isActive: false }),
      unitRow({ id: "current-active", isActive: true }),
      unitRow({ id: "old-inactive-2", isActive: false }),
    ],
  });
  const mod = load(db);
  const fn = mod.findOrganizationUnitByCode as (code: string) => Promise<{ id: string } | null>;
  assert.equal((await fn("packing"))?.id, "current-active");
});

test("findOrganizationUnitByCode: 2+ dòng ACTIVE cùng code (vi phạm bất biến DB) -> ném OrgTreeError CODE_AMBIGUOUS_ACTIVE, KHÔNG đoán", async () => {
  const db = createFakeDb({
    respond: () => [unitRow({ id: "a", isActive: true }), unitRow({ id: "b", isActive: true })],
  });
  const mod = load(db);
  const fn = mod.findOrganizationUnitByCode as (code: string) => Promise<unknown>;
  await assert.rejects(() => fn("packing"), (e: Error & { code?: string }) => e.code === "CODE_AMBIGUOUS_ACTIVE");
});

test("findOrganizationUnitByCode: 0 active, đúng 1 inactive -> vẫn trả về (duy nhất), isActive=false", async () => {
  const db = createFakeDb({ respond: () => [unitRow({ id: "retired", isActive: false })] });
  const mod = load(db);
  const fn = mod.findOrganizationUnitByCode as (code: string) => Promise<{ id: string; isActive: boolean } | null>;
  const result = await fn("packing");
  assert.equal(result?.id, "retired");
  assert.equal(result?.isActive, false);
});

test("findOrganizationUnitByCode: 0 active, 2+ inactive cùng code (retired code từng bị dùng lại trước PR1) -> ném OrgTreeError CODE_AMBIGUOUS_INACTIVE", async () => {
  const db = createFakeDb({
    respond: () => [unitRow({ id: "old-1", isActive: false }), unitRow({ id: "old-2", isActive: false })],
  });
  const mod = load(db);
  const fn = mod.findOrganizationUnitByCode as (code: string) => Promise<unknown>;
  await assert.rejects(() => fn("packing"), (e: Error & { code?: string }) => e.code === "CODE_AMBIGUOUS_INACTIVE");
});

/* ------------------------------------------------------------
   findOrganizationUnitByLegacyDepartmentId
   ------------------------------------------------------------ */

test("findOrganizationUnitByLegacyDepartmentId: không tìm thấy -> null", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);
  const fn = mod.findOrganizationUnitByLegacyDepartmentId as (id: string) => Promise<unknown>;
  assert.equal(await fn("dept-x"), null);
});

test("findOrganizationUnitByLegacyDepartmentId: đúng 1 dòng -> trả về", async () => {
  const db = createFakeDb({ respond: () => [unitRow({ id: "unit-9", legacyDepartmentId: "dept-9" })] });
  const mod = load(db);
  const fn = mod.findOrganizationUnitByLegacyDepartmentId as (id: string) => Promise<{ id: string } | null>;
  assert.equal((await fn("dept-9"))?.id, "unit-9");
});

test("findOrganizationUnitByLegacyDepartmentId: 2+ dòng cùng legacy_department_id (vi phạm org_units_legacy_dept_uq) -> ném OrgTreeError LEGACY_MAPPING_DUPLICATE", async () => {
  const db = createFakeDb({
    respond: () => [unitRow({ id: "dup-1" }), unitRow({ id: "dup-2" })],
  });
  const mod = load(db);
  const fn = mod.findOrganizationUnitByLegacyDepartmentId as (id: string) => Promise<unknown>;
  await assert.rejects(() => fn("dept-x"), (e: Error & { code?: string }) => e.code === "LEGACY_MAPPING_DUPLICATE");
});

/* ------------------------------------------------------------
   getLegacyDepartmentIdForUnit — reverse lookup, mục XVII: null, không đoán
   ------------------------------------------------------------ */

test("getLegacyDepartmentIdForUnit: unit không tồn tại -> null", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);
  const fn = mod.getLegacyDepartmentIdForUnit as (id: string) => Promise<string | null>;
  assert.equal(await fn("missing"), null);
});

test("getLegacyDepartmentIdForUnit: unit tồn tại nhưng chưa gắn legacy bridge (node thuần trên cây) -> null", async () => {
  const db = createFakeDb({ respond: () => [unitRow({ legacyDepartmentId: null })] });
  const mod = load(db);
  const fn = mod.getLegacyDepartmentIdForUnit as (id: string) => Promise<string | null>;
  assert.equal(await fn("unit-1"), null);
});

test("getLegacyDepartmentIdForUnit: unit có legacy bridge -> trả đúng departments.id", async () => {
  const db = createFakeDb({ respond: () => [unitRow({ legacyDepartmentId: "dept-42" })] });
  const mod = load(db);
  const fn = mod.getLegacyDepartmentIdForUnit as (id: string) => Promise<string | null>;
  assert.equal(await fn("unit-1"), "dept-42");
});

/* ------------------------------------------------------------
   createOrganizationUnit — GOVERNANCE FIX: code collision check giờ xét TOÀN
   BỘ dòng (active lẫn inactive), không chỉ active — chặn retired-code reuse.
   ------------------------------------------------------------ */

test("createOrganizationUnit: code trùng với 1 unit ĐÃ INACTIVE (retired code) -> KHÔNG tái sử dụng, tự thử code-2 tiếp theo", async () => {
  const codeChecks: unknown[] = [];
  const db = createFakeDb({
    respond(call: QueryCall) {
      if (call.root === "select" && call.table === "organization_units") {
        const codeVal = eqValue(call, "organization_units.code");
        if (codeVal !== undefined) {
          codeChecks.push(codeVal);
          return codeVal === "packing" ? [{ id: "retired-unit-id" }] : [];
        }
        const idVal = eqValue(call, "organization_units.id");
        if (idVal === "parent-1") return [{ id: "parent-1", path: "root", isActive: true }];
      }
      return undefined;
    },
  });
  const mod = load(db);
  const fn = mod.createOrganizationUnit as (input: Record<string, unknown>) => Promise<unknown>;

  await fn({ name: "Packing", unitType: "OTHER", parentId: "parent-1", actor: { username: "tester" } });

  assert.deepEqual(codeChecks, ["packing", "packing-2"]);
});

test("createOrganizationUnit: code không trùng bất kỳ dòng nào (active lẫn inactive) -> nhận ngay lần đầu, không retry", async () => {
  const codeChecks: unknown[] = [];
  const db = createFakeDb({
    respond(call: QueryCall) {
      if (call.root === "select" && call.table === "organization_units") {
        const codeVal = eqValue(call, "organization_units.code");
        if (codeVal !== undefined) {
          codeChecks.push(codeVal);
          return [];
        }
        const idVal = eqValue(call, "organization_units.id");
        if (idVal === "parent-1") return [{ id: "parent-1", path: "root", isActive: true }];
      }
      return undefined;
    },
  });
  const mod = load(db);
  const fn = mod.createOrganizationUnit as (input: Record<string, unknown>) => Promise<unknown>;

  await fn({ name: "Greenhouse", unitType: "OTHER", parentId: "parent-1", actor: { username: "tester" } });

  assert.deepEqual(codeChecks, ["greenhouse"]);
});
