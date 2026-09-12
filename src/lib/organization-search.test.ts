/**
 * AI ORGANIZATION ENTITY RESOLUTION — canonical searchOrganizationUnits()/
 * resolveOrganizationUnit() (src/lib/organization-search.ts).
 * ------------------------------------------------------------
 * Production regression: user asked the AI "Fast thì sao" — the AI claimed
 * no department named "Fast" exists and claimed it had cross-referenced the
 * entire department list, while the real Organization UI shows three real
 * units ("Chrysanth Spray — Fast", "... Fast G", "... Fast H"). Root cause
 * (proven, not assumed): the AI's list_departments tool matched
 * `departments.deptName === search` (exact string equality) against the
 * FLAT departments table, whose deptName column ("Chrysanth Spray") never
 * contains "Fast" at all — "Fast" only exists in departments.groupName,
 * and the compound display name "Chrysanth Spray — Fast" the admin UI
 * shows is composed at organization_units-migration time as
 * `deptName || ' — ' || groupName` (migrations/2026-08-17-organization-units.sql).
 * A byte-for-byte-partial fix (exact -> contains, still against deptName
 * alone) would STILL return zero rows for "Fast" — the bug is column
 * choice, not comparison operator. This file proves that with the first
 * test below, then exercises the real fix: searching organization_units
 * (the same table the Cây tổ chức admin UI reads) via the canonical
 * resolver.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

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

function unit(partial: Partial<Unit> & { id: string; name: string; parentId: string | null; path: string }): Unit {
  return {
    code: partial.id,
    unitType: "DEPARTMENT",
    depth: partial.path.split(".").length - 1,
    sortOrder: 0,
    isActive: true,
    legacyDepartmentId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...partial,
  };
}

const ROOT: Unit = unit({ id: "root", name: "Dalat Hasfarm", unitType: "COMPANY", parentId: null, path: "root", legacyDepartmentId: null });

/* Mandatory regression fixture (mission section 21) — literal names, composed
   exactly the way the real migration composes them: deptName + ' — ' + groupName. */
const FIXTURE_NAMES = [
  "Chrysanth Calimero G",
  "Chrysanth Calimero H",
  "Chrysanth Rossi",
  "Chrysanth Rossi G",
  "Chrysanth Rossi H",
  "Chrysanth Spray — Fast",
  "Chrysanth Spray — Fast G",
  "Chrysanth Spray — Fast H",
  "Chrysanth Spray — Middle 1",
  "Chrysanth Spray — Middle 1 G",
  "Chrysanth Spray — Middle 1 H",
];

const FIXTURE_UNITS: Unit[] = [
  ROOT,
  ...FIXTURE_NAMES.map((name, i) =>
    unit({ id: `dept-${i + 1}`, name, parentId: "root", path: `root.leaf${i + 1}`, legacyDepartmentId: `dept-${i + 1}` }),
  ),
];

function load(units: Unit[]) {
  return loadModule(new URL("./organization-search.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "@/lib/organization-units": { listAllUnits: async () => units },
      "@/lib/organization-tree": { isDescendantPath },
    },
  }) as unknown as {
    searchOrganizationUnits: (params: { query: string; scope: string[] | null; includeInactive?: boolean; limit?: number }) => Promise<{
      status: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";
      totalMatches: number;
      truncated: boolean;
      normalizedQuery: string;
      candidates: { id: string; name: string; isActive: boolean; legacyDepartmentId: string | null; breadcrumb: { id: string; name: string }[] }[];
    }>;
    resolveOrganizationUnit: (params: { query: string; scope: string[] | null; includeInactive?: boolean }) => Promise<
      | { status: "RESOLVED"; unit: { id: string; name: string } }
      | { status: "AMBIGUOUS"; candidates: { id: string; name: string }[] }
      | { status: "NOT_FOUND" }
    >;
    normalizeSearchText: (s: string) => string;
  };
}

/* ============================================================
   REGRESSION CONTROL — proves the OLD bug from data shape alone, before
   any test of the new resolver even runs.
   ============================================================ */
test("REGRESSION CONTROL: OLD exact-match against departments.deptName can NEVER find 'Fast' — 'Fast' lives only in groupName, not deptName", () => {
  const flatDepartments = [
    { id: "dept-6", deptName: "Chrysanth Spray", groupName: "Fast" },
    { id: "dept-7", deptName: "Chrysanth Spray", groupName: "Fast G" },
    { id: "dept-8", deptName: "Chrysanth Spray", groupName: "Fast H" },
  ];
  // This is the literal OLD condition: eq(departments.deptName, args.search).
  const oldExactMatch = flatDepartments.filter((d) => d.deptName === "Fast");
  assert.equal(oldExactMatch.length, 0, "OLD exact match on deptName alone must reproduce the Production false-zero bug");

  // A naive "just make it a contains/ILIKE on deptName" fix would ALSO fail —
  // proving the fix must target the composed name, not the comparison operator.
  const naiveContainsOnDeptNameAlone = flatDepartments.filter((d) => d.deptName.toLowerCase().includes("fast"));
  assert.equal(naiveContainsOnDeptNameAlone.length, 0, "a contains-match on deptName ALONE would still miss 'Fast' — proves the real bug is column choice");

  // The real compound name only exists once composed exactly like the organization_units migration does.
  const composed = flatDepartments.map((d) => `${d.deptName} — ${d.groupName}`);
  assert.deepEqual(composed, ["Chrysanth Spray — Fast", "Chrysanth Spray — Fast G", "Chrysanth Spray — Fast H"]);
});

/* ============================================================
   PRODUCTION CASE — "Fast" must return the 3 real units, not zero.
   ============================================================ */
test("searchOrganizationUnits: query 'Fast' resolves the exact Production regression — AMBIGUOUS with the 3 real Fast units, never NOT_FOUND/zero", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "Fast", scope: null });
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.totalMatches, 3);
  assert.deepEqual(
    Array.from(result.candidates, (c) => c.name).sort(),
    ["Chrysanth Spray — Fast", "Chrysanth Spray — Fast G", "Chrysanth Spray — Fast H"],
  );
});

/* ============================================================
   E1-E10 — mandatory matching tests
   ============================================================ */
test("E1: exact match ranks first (unique RESOLVED, not swamped by prefix matches)", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "Chrysanth Rossi", scope: null });
  assert.equal(result.status, "RESOLVED");
  assert.equal(result.candidates[0].name, "Chrysanth Rossi");
});

test("E2: lowercase 'fast' -> same 3 Fast candidates (case-insensitive)", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "fast", scope: null });
  assert.equal(result.totalMatches, 3);
  assert.equal(result.status, "AMBIGUOUS");
});

test("E3: punctuation 'Spray - Fast' -> Fast candidates only", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "Spray - Fast", scope: null });
  assert.equal(result.totalMatches, 3);
  assert.ok(result.candidates.every((c) => c.name.includes("Fast")));
});

test("E4: token order 'Fast Spray' -> still matches the Fast candidates (order-independent)", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "Fast Spray", scope: null });
  assert.equal(result.totalMatches, 3);
  assert.ok(result.candidates.every((c) => c.name.includes("Fast")));
});

test("E5: suffix 'Fast G' -> uniquely RESOLVED to 'Chrysanth Spray — Fast G'", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "Fast G", scope: null });
  assert.equal(result.status, "RESOLVED");
  assert.equal(result.candidates[0].name, "Chrysanth Spray — Fast G");
});

test("E6: 'Middle 1' -> the Middle 1 family (3 candidates), AMBIGUOUS", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "Middle 1", scope: null });
  assert.equal(result.totalMatches, 3);
  assert.deepEqual(
    Array.from(result.candidates, (c) => c.name).sort(),
    ["Chrysanth Spray — Middle 1", "Chrysanth Spray — Middle 1 G", "Chrysanth Spray — Middle 1 H"],
  );
});

test("E7: 'Rossi' -> the Rossi family (3 candidates)", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "Rossi", scope: null });
  assert.equal(result.totalMatches, 3);
  assert.deepEqual(
    Array.from(result.candidates, (c) => c.name).sort(),
    ["Chrysanth Rossi", "Chrysanth Rossi G", "Chrysanth Rossi H"],
  );
});

test("E8: whitespace ' fast   g' -> uniquely resolves to Fast G", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: " fast   g", scope: null });
  assert.equal(result.status, "RESOLVED");
  assert.equal(result.candidates[0].name, "Chrysanth Spray — Fast G");
});

test("E9: 'DefinitelyMissingUnit' -> true NOT_FOUND", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "DefinitelyMissingUnit", scope: null });
  assert.equal(result.status, "NOT_FOUND");
  assert.equal(result.totalMatches, 0);
  assert.equal(result.candidates.length, 0);
});

test("E10: two units with the SAME leaf name in different branches -> AMBIGUOUS, never arbitrarily resolved to one", async () => {
  const divA = unit({ id: "div-a", name: "Division A", parentId: "root", path: "root.diva" });
  const divB = unit({ id: "div-b", name: "Division B", parentId: "root", path: "root.divb" });
  const fastInA = unit({ id: "fast-a", name: "Fast", parentId: "div-a", path: "root.diva.fast", legacyDepartmentId: "dept-fast-a" });
  const fastInB = unit({ id: "fast-b", name: "Fast", parentId: "div-b", path: "root.divb.fast", legacyDepartmentId: "dept-fast-b" });
  const mod = load([ROOT, divA, divB, fastInA, fastInB]);
  const result = await mod.searchOrganizationUnits({ query: "Fast", scope: null });
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.totalMatches, 2);
  const breadcrumbs = Array.from(result.candidates, (c) => Array.from(c.breadcrumb, (b) => b.name).join(" > "));
  assert.deepEqual(breadcrumbs.sort(), ["Dalat Hasfarm > Division A > Fast", "Dalat Hasfarm > Division B > Fast"]);
});

/* ============================================================
   Data Scope tests
   ============================================================ */
test("Data Scope: caller authorized only for Fast + Fast G (not Fast H) -> 'Fast' returns only the 2 authorized units, no leak of Fast H's name or count", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "Fast", scope: ["dept-6", "dept-7"] });
  assert.equal(result.totalMatches, 2);
  const names = Array.from(result.candidates, (c) => c.name).sort();
  assert.deepEqual(names, ["Chrysanth Spray — Fast", "Chrysanth Spray — Fast G"]);
  assert.ok(!names.some((n) => n.includes("Fast H")), "Fast H must never appear — caller is not authorized for it");
});

test("Data Scope: zero authorized departments (scope=[]) -> NOT_FOUND even though global matches exist, never reveals 'there are matches you cannot see'", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "Fast", scope: [] });
  assert.equal(result.status, "NOT_FOUND");
  assert.equal(result.totalMatches, 0);
  assert.equal(result.candidates.length, 0);
});

test("Data Scope: a structural (non-leaf) unit with no legacyDepartmentId is only discoverable if the caller is authorized for at least one descendant", async () => {
  const divA = unit({ id: "div-a", name: "Farm Division", parentId: "root", path: "root.diva" });
  const leaf = unit({ id: "leaf-a", name: "Farm Division Leaf", parentId: "div-a", path: "root.diva.leaf", legacyDepartmentId: "dept-leaf-a" });
  const modAuthorized = load([ROOT, divA, leaf]);
  const authorizedResult = await modAuthorized.searchOrganizationUnits({ query: "Farm Division", scope: ["dept-leaf-a"] });
  assert.ok(authorizedResult.candidates.some((c) => c.id === "div-a"), "structural node visible when caller is authorized for a descendant");

  const modUnauthorized = load([ROOT, divA, leaf]);
  const unauthorizedResult = await modUnauthorized.searchOrganizationUnits({ query: "Farm Division", scope: ["dept-somewhere-else"] });
  assert.equal(unauthorizedResult.status, "NOT_FOUND", "structural node must not leak when caller has zero visibility into its subtree");
});

/* ============================================================
   Active/inactive
   ============================================================ */
test("Active/inactive: an inactive unit is excluded by default and only surfaces with includeInactive=true", async () => {
  const inactiveFast = unit({ id: "dept-old", name: "Chrysanth Spray — Fast Old", parentId: "root", path: "root.leafold", isActive: false, legacyDepartmentId: "dept-old" });
  const mod = load([...FIXTURE_UNITS, inactiveFast]);

  const defaultResult = await mod.searchOrganizationUnits({ query: "Fast Old", scope: null });
  assert.equal(defaultResult.status, "NOT_FOUND", "inactive units must not match by default");

  const modAgain = load([...FIXTURE_UNITS, inactiveFast]);
  const includingInactive = await modAgain.searchOrganizationUnits({ query: "Fast Old", scope: null, includeInactive: true });
  assert.equal(includingInactive.status, "RESOLVED");
  assert.equal(includingInactive.candidates[0].name, "Chrysanth Spray — Fast Old");
});

/* ============================================================
   Truncation honesty
   ============================================================ */
test("Truncation: limit smaller than total matches sets truncated=true and totalMatches reflects the real count", async () => {
  const mod = load(FIXTURE_UNITS);
  const result = await mod.searchOrganizationUnits({ query: "Chrysanth", scope: null, limit: 3 });
  assert.equal(result.truncated, true);
  assert.equal(result.totalMatches, FIXTURE_NAMES.length);
  assert.equal(result.candidates.length, 3);
});

/* ============================================================
   resolveOrganizationUnit() discriminated union
   ============================================================ */
test("resolveOrganizationUnit: RESOLVED/AMBIGUOUS/NOT_FOUND are distinct — never overloads [] to mean every state", async () => {
  const mod = load(FIXTURE_UNITS);
  const resolved = await mod.resolveOrganizationUnit({ query: "Fast G", scope: null });
  assert.equal(resolved.status, "RESOLVED");
  assert.ok("unit" in resolved && resolved.unit.name === "Chrysanth Spray — Fast G");

  const ambiguous = await mod.resolveOrganizationUnit({ query: "Fast", scope: null });
  assert.equal(ambiguous.status, "AMBIGUOUS");
  assert.ok("candidates" in ambiguous && ambiguous.candidates.length === 3);

  const notFound = await mod.resolveOrganizationUnit({ query: "NoSuchUnitAtAll", scope: null });
  assert.equal(notFound.status, "NOT_FOUND");
  assert.ok(!("candidates" in notFound) && !("unit" in notFound));
});

test("normalizeSearchText: strips Vietnamese diacritics, folds dash variants, collapses whitespace", () => {
  const mod = load(FIXTURE_UNITS);
  assert.equal(mod.normalizeSearchText("  Xưởng — Rossi  "), "xuong rossi");
  assert.equal(mod.normalizeSearchText("Đà Lạt"), "da lat");
});
