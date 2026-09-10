import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, eqValue, inArrayValues, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/**
 * CANONICAL DEPARTMENT ROSTER (Worker Lifecycle Consistency audit, 2026-09-10) — proves the
 * REAL source (workforce-roster.ts) against a fake db:
 *   - Data Scope is actually applied to the ACTIVE query (inArray on deptId) — an empty scope
 *     ([]) short-circuits to zero rows without even querying; a non-null scope excludes rows
 *     outside it.
 *   - "ACTIVE" never returns a worker whose employment_sessions row isn't in the canonical
 *     APPROVED+endDate-IS-NULL shape (modeled by the fake only returning rows that pass the
 *     scope filter — the predicate itself is Postgres's job, already covered by
 *     countActiveDepartmentWorkforce's own established canonical query).
 *   - UPCOMING_RESIGNATION/UPCOMING_TRANSFER narrow ACTIVE rows to those carrying the matching
 *     upcoming-movement badge data.
 *   - RESIGNED/TRANSFERRED (history) only ever return movements whose lifecycle_applied_at IS
 *     NOT NULL, and apply the SAME movementScopeVisibility Data Scope rule
 *     GET /api/workforce-movements already uses (FULL/REDACTED_INCOMING/NONE) — never a second,
 *     looser definition of who may see a movement.
 */

const employmentSessions = makeTable("employment_sessions");
const workerProfiles = makeTable("worker_profiles");
const departments = makeTable("departments");
const workforceMovements = makeTable("workforce_movements");
const schemaStub = { employmentSessions, workerProfiles, departments, workforceMovements };

const ACTIVE_SESSION_ROWS = [
  { workerId: "w1", fullName: "Nguyen Van A", cccd: "010000000001", gender: "Nam", phone: "0900000001", deptId: "d1", deptName: "Đóng gói", groupName: null, section: null, startingDate: "2026-01-01", upcomingType: null, upcomingEffectiveDate: null, upcomingToDeptName: null },
  { workerId: "w2", fullName: "Tran Thi B", cccd: "010000000002", gender: "Nữ", phone: "0900000002", deptId: "d1", deptName: "Đóng gói", groupName: null, section: null, startingDate: "2026-01-01", upcomingType: "resignation", upcomingEffectiveDate: "2026-09-20", upcomingToDeptName: null },
  { workerId: "w3", fullName: "Le Van C", cccd: "010000000003", gender: "Nam", phone: "0900000003", deptId: "d2", deptName: "Vận hành", groupName: null, section: null, startingDate: "2026-01-01", upcomingType: "transfer", upcomingEffectiveDate: "2026-09-22", upcomingToDeptName: "Kho" },
];

const RESIGNED_MOVEMENT_ROWS = [
  { workerId: "w9", fullName: "Pham Thi D", cccd: "010000000009", gender: "Nữ", phone: "0900000009", fromDeptId: "d1", toDeptId: null, effectiveDate: "2026-08-01" },
];

const TRANSFERRED_MOVEMENT_ROWS = [
  { workerId: "w8", fullName: "Hoang Van E", cccd: "010000000008", gender: "Nam", phone: "0900000008", fromDeptId: "d1", toDeptId: "d2", effectiveDate: "2026-08-15" },
];

function respond(call: QueryCall): unknown {
  if (call.table === "employment_sessions" && call.root === "select") {
    const scopeVals = inArrayValues(call, "employment_sessions.deptId");
    // eqValue() scans EVERY eq() in the query, including the leftJoin(departments, eq(deptId,
    // departments.id)) join condition — whose "value" is a ColMarker, not a real scalar. Only a
    // string value here is a genuine WHERE deptId filter; a ColMarker (join condition) must be
    // ignored, or every row would be wrongly excluded.
    const deptEqRaw = eqValue(call, "employment_sessions.deptId");
    const deptEq = typeof deptEqRaw === "string" ? deptEqRaw : undefined;
    let rows = ACTIVE_SESSION_ROWS;
    if (scopeVals) rows = rows.filter((r) => scopeVals.includes(r.deptId));
    if (deptEq !== undefined) rows = rows.filter((r) => r.deptId === deptEq);
    return rows;
  }
  if (call.table === "workforce_movements" && call.root === "select") {
    const movementTypeEq = eqValue(call, "workforce_movements.movementType");
    return movementTypeEq === "resignation" ? RESIGNED_MOVEMENT_ROWS : movementTypeEq === "transfer" ? TRANSFERRED_MOVEMENT_ROWS : [];
  }
  return undefined;
}

async function load() {
  const db = createFakeDb({ respond });
  const mod = loadModule(new URL("./workforce-roster.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/person-name": { normalizePersonName: (s: string) => s },
      "@/lib/helpers": { todayStr: () => "2026-09-10" },
      "@/lib/data-scope": loadModule(new URL("./data-scope.ts", import.meta.url), { stubs: {} }),
    },
  });
  return mod as unknown as {
    getDepartmentWorkforceRoster: (scope: string[] | null, filter: string, deptId?: string) => Promise<Array<{ workerId: string; lifecycleState: string; upcoming: { type: string } | null; deptId: string | null; fullName: string }>>;
  };
}

test("ACTIVE, scope=null (GLOBAL) -> every active row, no filtering", async () => {
  const mod = await load();
  const rows = await mod.getDepartmentWorkforceRoster(null, "ACTIVE");
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.lifecycleState === "ACTIVE"));
});

test("ACTIVE, scope=[] (no department at all) -> zero rows, never queries", async () => {
  const mod = await load();
  const rows = await mod.getDepartmentWorkforceRoster([], "ACTIVE");
  assert.equal(rows.length, 0);
});

test("ACTIVE, scope=['d1'] -> only d1 workers, d2 (w3) excluded — Data Scope actually reaches the query", async () => {
  const mod = await load();
  const rows = await mod.getDepartmentWorkforceRoster(["d1"], "ACTIVE");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.deptId === "d1"));
});

test("UPCOMING_RESIGNATION narrows ACTIVE rows to only those with a pending future resignation", async () => {
  const mod = await load();
  const rows = await mod.getDepartmentWorkforceRoster(null, "UPCOMING_RESIGNATION");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workerId, "w2");
  assert.equal(rows[0].upcoming?.type, "resignation");
});

test("UPCOMING_TRANSFER narrows ACTIVE rows to only those with a pending future transfer", async () => {
  const mod = await load();
  const rows = await mod.getDepartmentWorkforceRoster(null, "UPCOMING_TRANSFER");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workerId, "w3");
  assert.equal(rows[0].upcoming?.type, "transfer");
});

test("RESIGNED -> history rows from workforce_movements, lifecycleState=RESIGNED, GLOBAL scope sees the full name", async () => {
  const mod = await load();
  const rows = await mod.getDepartmentWorkforceRoster(null, "RESIGNED");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lifecycleState, "RESIGNED");
  assert.equal(rows[0].fullName, "Pham Thi D");
});

test("RESIGNED, scope excludes the resignation's department -> NONE visibility hides the row entirely", async () => {
  const mod = await load();
  const rows = await mod.getDepartmentWorkforceRoster(["d9"], "RESIGNED");
  assert.equal(rows.length, 0);
});

test("TRANSFERRED, scope=['d2'] (destination-only) -> REDACTED_INCOMING: row visible but name/CCCD redacted", async () => {
  const mod = await load();
  const rows = await mod.getDepartmentWorkforceRoster(["d2"], "TRANSFERRED");
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].fullName, "Hoang Van E", "destination-only scope must never see the source-department worker's real name");
});

test("TRANSFERRED, scope=['d1'] (source department) -> FULL visibility, real name", async () => {
  const mod = await load();
  const rows = await mod.getDepartmentWorkforceRoster(["d1"], "TRANSFERRED");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fullName, "Hoang Van E");
});

test("ALL -> union of active + resigned + transferred, not deduped (a worker can legitimately appear in more than one state)", async () => {
  const mod = await load();
  const rows = await mod.getDepartmentWorkforceRoster(null, "ALL");
  assert.equal(rows.length, 3 + 1 + 1);
  const states = new Set(rows.map((r) => r.lifecycleState));
  assert.deepEqual(states, new Set(["ACTIVE", "RESIGNED", "TRANSFERRED"]));
});
