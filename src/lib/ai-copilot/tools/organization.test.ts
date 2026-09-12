/**
 * AI ORGANIZATION ENTITY RESOLUTION — tool-level tests for organization.ts.
 * ------------------------------------------------------------
 * Runs the REAL organization.ts AND the REAL organization-search.ts together
 * (only the true DB boundary — listAllUnits()/the departments table select —
 * is stubbed), proving actual tool execution end-to-end, not just the pure
 * matcher in isolation (mission requirement: AI tool execution test).
 *
 *   1. search_organization_units: query "Fast" -> AMBIGUOUS with the 3 real
 *      units (the exact Production regression), and Data Scope narrows it
 *      correctly.
 *   2. list_departments: `search` is now powered by the SAME canonical
 *      resolver — "Fast" resolves to the department rows behind the 3
 *      matching organization_units, never the OLD `eq(deptName, "Fast")`
 *      zero-result bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../../test-support/load-module.ts";

type Unit = {
  id: string;
  code: string;
  name: string;
  unitType: string;
  parentId: string | null;
  path: string;
  depth: number;
  sortOrder: number;
  isActive: boolean;
  legacyDepartmentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function isDescendantPath(candidatePath: string, ancestorPath: string): boolean {
  return candidatePath === ancestorPath || candidatePath.startsWith(`${ancestorPath}.`);
}

function unit(p: Partial<Unit> & { id: string; name: string; parentId: string | null; path: string }): Unit {
  return {
    code: p.id,
    unitType: "DEPARTMENT",
    depth: p.path.split(".").length - 1,
    sortOrder: 0,
    isActive: true,
    legacyDepartmentId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...p,
  };
}

const ROOT = unit({ id: "root", name: "Dalat Hasfarm", unitType: "COMPANY", parentId: null, path: "root" });
const FAST = unit({ id: "u-fast", name: "Chrysanth Spray — Fast", parentId: "root", path: "root.fast", legacyDepartmentId: "dept-fast" });
const FAST_G = unit({ id: "u-fast-g", name: "Chrysanth Spray — Fast G", parentId: "root", path: "root.fastg", legacyDepartmentId: "dept-fast-g" });
const FAST_H = unit({ id: "u-fast-h", name: "Chrysanth Spray — Fast H", parentId: "root", path: "root.fasth", legacyDepartmentId: "dept-fast-h" });
const ROSSI = unit({ id: "u-rossi", name: "Chrysanth Rossi", parentId: "root", path: "root.rossi", legacyDepartmentId: "dept-rossi" });
const UNITS = [ROOT, FAST, FAST_G, FAST_H, ROSSI];

const DEPT_ROWS = [
  { id: "dept-fast", deptName: "Chrysanth Spray", isActive: true, deletedAt: null },
  { id: "dept-fast-g", deptName: "Chrysanth Spray", isActive: true, deletedAt: null },
  { id: "dept-fast-h", deptName: "Chrysanth Spray", isActive: true, deletedAt: null },
  { id: "dept-rossi", deptName: "Chrysanth Rossi", isActive: true, deletedAt: null },
];

function loadOrgSearch(units: Unit[]) {
  return loadModule(new URL("../../organization-search.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "@/lib/organization-units": { listAllUnits: async () => units },
      "@/lib/organization-tree": { isDescendantPath },
    },
  });
}

type Row = Record<string, unknown>;
type Cond = (row: Row) => boolean;

function loadOrgTool(opts: { units: Unit[]; deptRows: Row[]; scope: string[] | null }) {
  const orgSearch = loadOrgSearch(opts.units);
  return loadModule(new URL("./organization.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": {
        and:
          (...conds: Cond[]): Cond =>
          (row) =>
            conds.every((c) => c(row)),
        eq:
          (col: string, val: unknown): Cond =>
          (row) =>
            row[col] === val,
        inArray:
          (col: string, arr: unknown[]): Cond =>
          (row) =>
            arr.includes(row[col]),
        isNull:
          (col: string): Cond =>
          (row) =>
            row[col] == null,
      },
      "@/db": {
        db: {
          select: (_sel: unknown) => ({
            from: (_table: unknown) => ({
              where: (cond: Cond) => ({
                limit: async (_n: number) => opts.deptRows.filter(cond).map((r) => ({ id: r.id, name: r.deptName })),
              }),
            }),
          }),
        },
      },
      "@/db/schema": {
        departments: { id: "id", deptName: "deptName", isActive: "isActive", deletedAt: "deletedAt" },
        employmentSessions: {},
        workerProfiles: {},
      },
      "@/lib/auth": { getUserScope: async () => opts.scope },
      "@/lib/helpers": { isFemale: () => false, isMale: () => false, todayStr: () => "2026-10-15" },
      "@/lib/recruitment-kpi": { countActiveDepartmentWorkforce: async () => ({ male: 0, female: 0, unknownGender: 0, total: 0 }) },
      "@/lib/organization-search": orgSearch,
      "../types.ts": {
        ToolExecutionError: class ToolExecutionError extends Error {
          code: string;
          constructor(code: string, message: string) {
            super(message);
            this.code = code;
          }
        },
      },
      "../scope-helpers.ts": {
        intersectDepartmentFilter: (scope: string[] | null, requested: string | null | undefined) => {
          const req = requested?.trim() || null;
          if (scope === null) return { ok: true, departmentIds: req ? [req] : null };
          if (!req) return { ok: true, departmentIds: scope };
          if (!scope.includes(req)) return { ok: false, reason: "OUT_OF_SCOPE" };
          return { ok: true, departmentIds: [req] };
        },
      },
    },
  }) as unknown as {
    organizationTools: {
      name: string;
      execute: (ctx: { session: unknown }, args: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
    }[];
  };
}

test("search_organization_units (real tool + real resolver): query 'Fast' -> AMBIGUOUS with the exact 3 Production units", async () => {
  const mod = loadOrgTool({ units: UNITS, deptRows: DEPT_ROWS, scope: null });
  const tool = mod.organizationTools.find((t) => t.name === "search_organization_units")!;
  const res = await tool.execute({ session: { id: "u1", role: "ADMIN" } }, { query: "Fast" });

  assert.equal(res.data.status, "AMBIGUOUS");
  assert.equal(res.data.totalMatches, 3);
  const candidates = res.data.candidates as { name: string; breadcrumb: string }[];
  assert.deepEqual(
    Array.from(candidates, (c) => c.name).sort(),
    ["Chrysanth Spray — Fast", "Chrysanth Spray — Fast G", "Chrysanth Spray — Fast H"],
  );
  assert.ok(candidates.every((c) => c.breadcrumb.includes("Dalat Hasfarm")), "breadcrumb must be a human-readable joined path");
});

test("search_organization_units: Data Scope narrows candidates — caller missing Fast H never sees it", async () => {
  const mod = loadOrgTool({ units: UNITS, deptRows: DEPT_ROWS, scope: ["dept-fast", "dept-fast-g"] });
  const tool = mod.organizationTools.find((t) => t.name === "search_organization_units")!;
  const res = await tool.execute({ session: { id: "u1", role: "HR_RECRUITER" } }, { query: "Fast" });

  assert.equal(res.data.totalMatches, 2);
  const names = Array.from(res.data.candidates as { name: string }[], (c) => c.name);
  assert.ok(!names.some((n) => n.includes("Fast H")));
});

test("search_organization_units: unique suffix 'Fast G' -> RESOLVED", async () => {
  const mod = loadOrgTool({ units: UNITS, deptRows: DEPT_ROWS, scope: null });
  const tool = mod.organizationTools.find((t) => t.name === "search_organization_units")!;
  const res = await tool.execute({ session: { id: "u1", role: "ADMIN" } }, { query: "Fast G" });
  assert.equal(res.data.status, "RESOLVED");
  assert.equal((res.data.candidates as { name: string }[])[0].name, "Chrysanth Spray — Fast G");
});

test("search_organization_units: truly missing name -> NOT_FOUND (only status allowed to say 'not found')", async () => {
  const mod = loadOrgTool({ units: UNITS, deptRows: DEPT_ROWS, scope: null });
  const tool = mod.organizationTools.find((t) => t.name === "search_organization_units")!;
  const res = await tool.execute({ session: { id: "u1", role: "ADMIN" } }, { query: "NoSuchUnitAnywhere" });
  assert.equal(res.data.status, "NOT_FOUND");
  assert.equal(res.data.totalMatches, 0);
});

test("list_departments: search='Fast' now resolves via the canonical resolver -> the 3 real departments behind the Fast units, NEVER zero (the exact Production regression)", async () => {
  const mod = loadOrgTool({ units: UNITS, deptRows: DEPT_ROWS, scope: null });
  const tool = mod.organizationTools.find((t) => t.name === "list_departments")!;
  const res = await tool.execute({ session: { id: "u1", role: "ADMIN" } }, { search: "Fast" });

  const ids = Array.from(res.data.departments as { id: string }[], (d) => d.id).sort();
  assert.deepEqual(ids, ["dept-fast", "dept-fast-g", "dept-fast-h"]);
});

test("list_departments: search with no match returns an empty list, not a crash", async () => {
  const mod = loadOrgTool({ units: UNITS, deptRows: DEPT_ROWS, scope: null });
  const tool = mod.organizationTools.find((t) => t.name === "list_departments")!;
  const res = await tool.execute({ session: { id: "u1", role: "ADMIN" } }, { search: "NoSuchUnitAnywhere" });
  assert.equal((res.data.departments as unknown[]).length, 0);
});

test("list_departments: Data Scope still intersects even with a resolved search — caller without Fast H access never sees its department row", async () => {
  const mod = loadOrgTool({ units: UNITS, deptRows: DEPT_ROWS, scope: ["dept-fast", "dept-fast-g"] });
  const tool = mod.organizationTools.find((t) => t.name === "list_departments")!;
  const res = await tool.execute({ session: { id: "u1", role: "HR_RECRUITER" } }, { search: "Fast" });
  const ids = Array.from(res.data.departments as { id: string }[], (d) => d.id).sort();
  assert.deepEqual(ids, ["dept-fast", "dept-fast-g"]);
});
