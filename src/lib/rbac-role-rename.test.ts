/**
 * RBAC ROLE-RENAME AUDIT — regression suite.
 *
 * Reproduces and proves the fix for the reported defect: a role whose
 * DISPLAY NAME is changed (e.g. "Administration" -> "C&B - Code DW") while
 * its immutable `key` (role_id in the bug report) and its role_permissions
 * rows stay untouched must see NO change in authorization outcome.
 *
 * Loads the REAL src/lib/auth.ts (via the repo's existing loadModule vm
 * sandbox pattern) with @/db faked and "jose" backed by the REAL jose
 * package, so getSession()/requirePermission() run through the actual
 * production JWT + DB-reconciliation logic, not a rewritten stand-in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as jose from "jose";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createFakeDb, drizzleStub, makeTable, eqValue, type FakeDb, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";
import * as rbacCatalog from "./rbac-catalog.ts";
import * as personName from "./person-name.ts";

process.env.AUTH_SECRET ||= "unit-test-secret-never-used-in-production";

const schemaStub = {
  auditLogs: makeTable("audit_logs"),
  rolePermissions: makeTable("role_permissions"),
  userDepartmentScopes: makeTable("user_department_scopes"),
  users: makeTable("users"),
};

/**
 * Values produced by array LITERALS inside the vm-sandboxed module (e.g.
 * auth.ts's own `[]` fallback) belong to the vm's own realm, so
 * assert.deepEqual/deepStrictEqual against an outer-realm `[]` fails on
 * prototype identity even though the content is identical. Duck-type
 * instead: same length, same elements, regardless of which realm built it.
 */
function assertScopeEquals(actual: unknown, expected: string[] | null, message?: string) {
  if (expected === null) {
    assert.equal(actual, null, message);
    return;
  }
  assert.ok(Array.isArray(actual), message ?? "expected an array-like scope value");
  assert.deepEqual(Array.from(actual as ArrayLike<unknown>), expected, message);
}

type Session = { id: string; username: string; fullName: string; role: string; deptId: string | null };
type Guard = { ok: true; session: Session } | { ok: false; status: number; error: string };

type AuthModule = {
  getSession: () => Promise<Session | null>;
  createSession: (session: Session & { sessionVersion: number }) => Promise<void>;
  requireRole: (roles: string[]) => Promise<Guard>;
  requirePermission: (roles: string[], key: string) => Promise<Guard>;
  hasPermission: (role: string, key: string) => Promise<boolean>;
  getSessionPermissionKeys: (session: Session) => Promise<string[]>;
  getUserScope: (session: Session) => Promise<string[] | null>;
  invalidatePermissionCache: () => void;
};

type UserRow = { id: string; username: string; fullName: string; role: string; deptId: string | null; isActive: boolean; sessionVersion: number };
type RolePermRow = { role: string; permissionKey: string; allowed: boolean };
type ScopeRow = { userId: string; departmentId: string };

/**
 * A fake cookie jar implementing exactly the `next/headers` cookies() surface
 * auth.ts uses: `(await cookies()).get(name)?.value`, `.set(name, value, opts)`,
 * `.delete(name)`.
 */
function makeCookieJar() {
  const store = new Map<string, string>();
  return {
    api: {
      get: (name: string) => (store.has(name) ? { value: store.get(name)! } : undefined),
      set: (name: string, value: string) => {
        store.set(name, value);
      },
      delete: (name: string) => {
        store.delete(name);
      },
    },
    store,
  };
}

function loadAuth(opts: {
  users: UserRow[];
  rolePermissionRows: RolePermRow[];
  scopeRows?: ScopeRow[];
}): { mod: AuthModule; db: FakeDb; cookies: ReturnType<typeof makeCookieJar> } {
  const cookies = makeCookieJar();
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "users") {
        const wantedId = eqValue(call, "users.id");
        return wantedId === undefined ? opts.users : opts.users.filter((u) => u.id === wantedId);
      }
      if (call.root === "select" && call.table === "role_permissions") {
        return opts.rolePermissionRows;
      }
      if (call.root === "select" && call.table === "user_department_scopes") {
        const wantedUserId = eqValue(call, "user_department_scopes.userId");
        return (opts.scopeRows ?? []).filter((r) => r.userId === wantedUserId);
      }
      if (call.root === "insert" && call.table === "audit_logs") return [];
      return undefined;
    },
  });

  const mod = loadModule(new URL("./auth.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "next/headers": { cookies: async () => cookies.api },
      jose: jose,
      crypto: { randomBytes, scryptSync, timingSafeEqual },
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/rbac-catalog": rbacCatalog,
      "@/lib/person-name": personName,
    },
  });
  return { mod: mod as unknown as AuthModule, db, cookies };
}

const USER_ID = "user-tranmai";

function baseUser(role: string, overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: USER_ID,
    username: "tranmai",
    fullName: "Trần Mai",
    role,
    deptId: null,
    isActive: true,
    sessionVersion: 1,
    ...overrides,
  };
}

/** Log in for real through the loaded module (createSession -> getSession), proving the actual JWT/DB path. */
async function loginAs(mod: AuthModule, user: UserRow): Promise<Session> {
  await mod.createSession({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    deptId: user.deptId,
    sessionVersion: user.sessionVersion,
  });
  const session = await mod.getSession();
  assert.ok(session, "login must produce a valid session");
  return session as Session;
}

/* ------------------------------------------------------------------ *
 * PHASE 6 — core scenario: role renamed, role_id/permissions unchanged.
 * ------------------------------------------------------------------ */

test("RBAC role-rename: hasPermission() never queries the roles table — a display-name rename cannot reach it", async () => {
  const { mod, db } = loadAuth({
    users: [baseUser("ADMINISTRATION")],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: true }],
  });
  const allowed = await mod.hasPermission("ADMINISTRATION", "dw.view");
  assert.equal(allowed, true);
  // Structural proof, not just a behavioural coincidence: the query never
  // touches a "roles" table at all, so roles.name (display label) literally
  // cannot influence the outcome, under any current or future rename.
  assert.equal(db.calls.some((c) => c.table === "roles"), false, "hasPermission must never read roles.name");
});

test("RBAC role-rename: tranmai's exact reported bug — DW Data denied despite a granted permission, because the route's hardcoded roles[] omits her role key", async () => {
  const { mod } = loadAuth({
    users: [baseUser("ADMINISTRATION")],
    // Confirmed fact #4 in the report: the permission matrix already grants
    // dw.view to this role (renamed display name "C&B - Code DW", key unchanged).
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: true }],
  });
  await loginAs(mod, baseUser("ADMINISTRATION"));

  // The EXACT allowlist GET /api/workers passes to requirePermission().
  const guard = await mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  assert.equal(guard.ok, true, "a role with the permission granted must be allowed regardless of role-name-array coverage");
});

test("RBAC role-rename: the SAME check denies a role that genuinely lacks the permission", async () => {
  const { mod } = loadAuth({
    users: [baseUser("ADMINISTRATION")],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: false }],
  });
  await loginAs(mod, baseUser("ADMINISTRATION"));
  const guard = await mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  assert.equal(guard.ok, false);
  assert.equal(guard.status, 403);
});

test("RBAC role-rename: no role_permissions row at all -> fail-closed denial (not a silent allow)", async () => {
  const { mod } = loadAuth({
    users: [baseUser("ADMINISTRATION")],
    rolePermissionRows: [], // never configured
  });
  await loginAs(mod, baseUser("ADMINISTRATION"));
  const guard = await mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  assert.equal(guard.ok, false);
  assert.equal(guard.status, 403);
});

test("RBAC role-rename: same role_id, permission granted THEN removed THEN granted again -> outcome follows the permission every time, key never changes", async () => {
  const { mod } = loadAuth({
    users: [baseUser("ADMINISTRATION")],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: true }],
  });
  await loginAs(mod, baseUser("ADMINISTRATION"));

  const allowed1 = await mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  assert.equal(allowed1.ok, true, "granted -> allowed");

  // Simulate an admin REMOVING the permission for the exact same role key
  // (role.key = "ADMINISTRATION" never changes, only its matrix row does).
  const revoked = loadAuth({
    users: [baseUser("ADMINISTRATION")],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: false }],
  });
  await loginAs(revoked.mod, baseUser("ADMINISTRATION"));
  const denied = await revoked.mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  assert.equal(denied.ok, false, "removed -> denied");

  // Granted again — same role key, third independent evaluation.
  const grantedAgain = loadAuth({
    users: [baseUser("ADMINISTRATION")],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: true }],
  });
  await loginAs(grantedAgain.mod, baseUser("ADMINISTRATION"));
  const allowed2 = await grantedAgain.mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  assert.equal(allowed2.ok, true, "granted again -> allowed again");
});

test("RBAC role-rename: a LEGACY role (ADMIN/HR_RECRUITER/DEPT_MANAGER) is STILL blocked by a route's hardcoded roles[] even with the permission granted — defense-in-depth is not weakened", async () => {
  const { mod } = loadAuth({
    users: [baseUser("DEPT_MANAGER")],
    rolePermissionRows: [{ role: "DEPT_MANAGER", permissionKey: "dw.view", allowed: true }],
  });
  await loginAs(mod, baseUser("DEPT_MANAGER"));
  // A route that (deliberately or not) never lists DEPT_MANAGER must still reject it —
  // this is the EXACT legacy allowlist behaviour, unchanged by the fix.
  const guard = await mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  assert.equal(guard.ok, false, "legacy roles remain gated by the route's hardcoded allowlist");
  assert.equal(guard.status, 403);
});

test("RBAC role-rename: a LEGACY role IN the roles[] array still needs the permission too (both layers still apply to legacy roles)", async () => {
  const { mod } = loadAuth({
    users: [baseUser("HR_RECRUITER")],
    rolePermissionRows: [{ role: "HR_RECRUITER", permissionKey: "dw.view", allowed: false }],
  });
  await loginAs(mod, baseUser("HR_RECRUITER"));
  const guard = await mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  assert.equal(guard.ok, false, "being in the array is not sufficient without the permission");
});

test("RBAC role-rename: ADMIN bypasses hasPermission() with zero role_permissions rows configured (still needs to be in the route's legacy allowlist, unchanged)", async () => {
  const { mod } = loadAuth({ users: [baseUser("ADMIN")], rolePermissionRows: [] });
  await loginAs(mod, baseUser("ADMIN"));
  // ADMIN is a LEGACY role (see LEGACY_ROLES) — the route's hardcoded allowlist
  // still applies to it exactly as before; the bypass is specifically that
  // hasPermission() never needs a configured row for ADMIN to pass.
  const listed = await mod.requirePermission(["ADMIN", "HR_RECRUITER"], "dw.view");
  assert.equal(listed.ok, true, "ADMIN needs zero role_permissions configuration to pass hasPermission()");

  const notListed = await mod.requirePermission(["HR_RECRUITER"], "dw.view"); // ADMIN omitted from the array
  assert.equal(notListed.ok, false, "ADMIN, being a legacy role, is still subject to the route's hardcoded allowlist");
});

test("RBAC role-rename: an unrecognised/unknown role key is fail-closed denied, never silently allowed", async () => {
  const { mod } = loadAuth({
    users: [baseUser("SOME_TYPO_ROLE")],
    rolePermissionRows: [],
  });
  await loginAs(mod, baseUser("SOME_TYPO_ROLE"));
  const guard = await mod.requirePermission(["ADMIN", "HR_RECRUITER"], "dw.view");
  assert.equal(guard.ok, false);
});

/* ------------------------------------------------------------------ *
 * PHASE 2 — session/JWT behaviour under role rename.
 * ------------------------------------------------------------------ */

test("RBAC role-rename: changing a role's PERMISSION for an already-logged-in session takes effect on the very next request without a new JWT", async () => {
  const user = baseUser("ADMINISTRATION");
  const { mod, cookies } = loadAuth({
    users: [user],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: false }],
  });
  await loginAs(mod, user);
  const token = cookies.store.get("hasfarm_session");
  assert.ok(token, "a real JWT was issued");

  const denied = await mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  assert.equal(denied.ok, false);

  // Load a SECOND module instance sharing the SAME issued token but with the
  // permission now granted (simulating: admin edits the matrix mid-session).
  // getSession() re-reads role from DB every call (P0-6) — no cache to bust.
  const second = loadAuth({
    users: [user],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: true }],
  });
  second.cookies.store.set("hasfarm_session", token!);
  const allowedNow = await second.mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
  assert.equal(allowedNow.ok, true, "same JWT, new permission state, no re-login required");
});

test("RBAC role-rename: disabling the ACCOUNT (isActive=false) invalidates the session even with the same still-valid JWT — proves session freshness is DB-driven, not JWT-cached", async () => {
  const user = baseUser("ADMINISTRATION");
  const { mod, cookies } = loadAuth({ users: [user], rolePermissionRows: [] });
  await loginAs(mod, user);
  const token = cookies.store.get("hasfarm_session");

  const disabled = loadAuth({ users: [{ ...user, isActive: false }], rolePermissionRows: [] });
  disabled.cookies.store.set("hasfarm_session", token!);
  const session = await disabled.mod.getSession();
  assert.equal(session, null, "a disabled account must not resolve a session even with a valid, unexpired JWT");
});

/* ------------------------------------------------------------------ *
 * PHASE 5 — Data Scope default must be capability-driven, not a
 * hardcoded 2-role-key allowlist, so Daily Application never mislabels a
 * non-manager role as "Department Manager mode".
 * ------------------------------------------------------------------ */

test("RBAC role-rename: getUserScope() default is capability-driven (data_scope.unrestricted), not a literal role === 'ADMIN' || role === 'HR_RECRUITER' check", async () => {
  const session: Session = { id: USER_ID, username: "tranmai", fullName: "Trần Mai", role: "ADMINISTRATION", deptId: null };

  const withoutGrant = loadAuth({ users: [baseUser("ADMINISTRATION")], rolePermissionRows: [] });
  assertScopeEquals(await withoutGrant.mod.getUserScope(session), [], "no data_scope.unrestricted, no explicit scope -> [] (unchanged safety-net default)");

  const withGrant = loadAuth({
    users: [baseUser("ADMINISTRATION")],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "data_scope.unrestricted", allowed: true }],
  });
  assert.equal(await withGrant.mod.getUserScope(session), null, "granting data_scope.unrestricted makes ANY role unrestricted, by capability, not by role identity");
});

test("RBAC role-rename: ADMIN and HR_RECRUITER keep their EXACT current unrestricted-by-default scope with zero extra configuration (baseline preserved)", async () => {
  for (const role of ["ADMIN", "HR_RECRUITER"]) {
    const { mod } = loadAuth({
      users: [baseUser(role)],
      // Baseline is seeded by seedRbacCatalog() in production; here we assert the
      // exact baseline list itself, then simulate it being present as configured rows.
      rolePermissionRows: rbacCatalog.BASELINE_ROLE_PERMISSIONS[role].map((permissionKey) => ({ role, permissionKey, allowed: true })),
    });
    const session: Session = { id: "u", username: "u", fullName: "U", role, deptId: null };
    assert.equal(await mod.getUserScope(session), null, `${role} must remain unrestricted by default`);
  }
});

test("RBAC role-rename: DEPT_MANAGER (a legacy, genuinely scoped role) is NOT accidentally broadened by the new capability — still [] by default", async () => {
  const { mod } = loadAuth({
    users: [baseUser("DEPT_MANAGER")],
    rolePermissionRows: rbacCatalog.BASELINE_ROLE_PERMISSIONS.DEPT_MANAGER.map((permissionKey) => ({ role: "DEPT_MANAGER", permissionKey, allowed: true })),
  });
  const session: Session = { id: "u", username: "u", fullName: "U", role: "DEPT_MANAGER", deptId: null };
  assertScopeEquals(await mod.getUserScope(session), []);
});

test("Dynamic RBAC V2 audit: data_scope.unrestricted now OUTRANKS an explicit user_department_scopes assignment — GLOBAL is a capability grant, not a default that explicit scope rows can narrow", async () => {
  const { mod } = loadAuth({
    users: [baseUser("ADMINISTRATION")],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "data_scope.unrestricted", allowed: true }],
    scopeRows: [{ userId: USER_ID, departmentId: "dept-1" }],
  });
  const session: Session = { id: USER_ID, username: "tranmai", fullName: "Trần Mai", role: "ADMINISTRATION", deptId: null };
  assert.equal(
    await mod.getUserScope(session),
    null,
    "data_scope.unrestricted must win over ANY leftover explicit scope rows — it is an active capability grant, not a fallback default",
  );
});

test("Dynamic RBAC V2 audit: WITHOUT data_scope.unrestricted, an explicit user_department_scopes assignment is still SCOPED exactly as before (precedence change only affects the unrestricted case)", async () => {
  const { mod } = loadAuth({
    users: [baseUser("ADMINISTRATION")],
    rolePermissionRows: [],
    scopeRows: [{ userId: USER_ID, departmentId: "dept-1" }],
  });
  const session: Session = { id: USER_ID, username: "tranmai", fullName: "Trần Mai", role: "ADMINISTRATION", deptId: null };
  assertScopeEquals(await mod.getUserScope(session), ["dept-1"], "explicit scope rows still apply normally for a role that lacks data_scope.unrestricted");
});

/* ------------------------------------------------------------------ *
 * ISSUE A (Dynamic RBAC V2 audit) — the 71-explicit-scope regression.
 * Before the latest audit, tranmai's real account had data_scope.unrestricted
 * = true AND 71 leftover user_department_scopes rows (later cleared by the
 * administrator). Because the old getUserScope() read explicit scope rows
 * BEFORE checking data_scope.unrestricted, this exact combination resolved
 * to SCOPED (the 71 department IDs), not GLOBAL — even though the account
 * had been explicitly granted unrestricted, company-wide access. Prior test
 * runs against the (by-then-cleared) live account could never have caught
 * this: they only ever exercised deptId != null + unrestricted, never
 * "explicit scopes non-empty + unrestricted". This test locks in the fixed,
 * canonical precedence with the exact reported shape (71 rows + deptId set).
 * ------------------------------------------------------------------ */

test("ISSUE A — exact regression: data_scope.unrestricted=true + 71 explicit user_department_scopes rows + deptId != null -> GLOBAL (null); explicit scopes must NOT reduce GLOBAL access", async () => {
  const scopeRows = Array.from({ length: 71 }, (_, i) => ({ userId: USER_ID, departmentId: `dept-${i + 1}` }));
  const { mod } = loadAuth({
    users: [baseUser("ADMINISTRATION", { deptId: "dept-cb" })],
    rolePermissionRows: [
      { role: "ADMINISTRATION", permissionKey: "dw.view", allowed: true },
      { role: "ADMINISTRATION", permissionKey: "data_scope.unrestricted", allowed: true },
    ],
    scopeRows,
  });
  const session: Session = { id: USER_ID, username: "tranmai", fullName: "Trần Mai", role: "ADMINISTRATION", deptId: "dept-cb" };
  assert.equal(
    await mod.getUserScope(session),
    null,
    "71 explicit department scopes + data_scope.unrestricted=true + deptId != null must still resolve to GLOBAL — the exact combination the previous audit could not have exercised, since the live scopes had already been cleared",
  );
});

test("ISSUE A — companion: data_scope.unrestricted=false + explicit user_department_scopes rows -> SCOPED (the restriction still works normally when unrestricted is NOT granted)", async () => {
  const scopeRows = Array.from({ length: 5 }, (_, i) => ({ userId: USER_ID, departmentId: `dept-${i + 1}` }));
  const { mod } = loadAuth({
    users: [baseUser("ADMINISTRATION", { deptId: "dept-cb" })],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: true }],
    scopeRows,
  });
  const session: Session = { id: USER_ID, username: "tranmai", fullName: "Trần Mai", role: "ADMINISTRATION", deptId: "dept-cb" };
  assertScopeEquals(
    await mod.getUserScope(session),
    scopeRows.map((r) => r.departmentId),
    "without data_scope.unrestricted, explicit scope rows must still produce SCOPED exactly as before",
  );
});

/* ------------------------------------------------------------------ *
 * EXACT REPORTED RUNTIME BUG — DW Data Data Scope defect for tranmai.
 * tranmai's "C&B - Code DW" role (ADMINISTRATION) is granted
 * data_scope.unrestricted via the batch permission editor, but her user
 * row's LEGACY `deptId` column is non-null (she organizationally belongs
 * to the C&B department — an org-chart placement, not an explicit Data
 * Scope grant). getUserScope() used to check the legacy `deptId` fallback
 * BEFORE the data_scope.unrestricted capability, so any role with a
 * non-null deptId was wrongly forced into a SCOPED array even after being
 * granted unrestricted access — and DW Data (which has no department key
 * column to filter by) then fail-closed denied with "không có department
 * key". data_scope.unrestricted is now checked FIRST of all — before
 * explicit user_department_scopes AND before the legacy deptId fallback.
 * ------------------------------------------------------------------ */

test("RBAC role-rename: tranmai's exact reported Data Scope defect — deptId set (org-chart placement) + data_scope.unrestricted granted + NO explicit user_department_scopes -> GLOBAL (null), never scoped by the legacy deptId column", async () => {
  const { mod } = loadAuth({
    users: [baseUser("ADMINISTRATION", { deptId: "dept-cb" })],
    rolePermissionRows: [
      { role: "ADMINISTRATION", permissionKey: "dw.view", allowed: true },
      { role: "ADMINISTRATION", permissionKey: "dw.edit", allowed: true },
      { role: "ADMINISTRATION", permissionKey: "dw.delete", allowed: true },
      { role: "ADMINISTRATION", permissionKey: "data_scope.unrestricted", allowed: true },
    ],
  });
  const session: Session = { id: USER_ID, username: "tranmai", fullName: "Trần Mai", role: "ADMINISTRATION", deptId: "dept-cb" };
  assert.equal(
    await mod.getUserScope(session),
    null,
    "data_scope.unrestricted must win over the legacy deptId column when there is no explicit user_department_scopes row",
  );
});

test("RBAC role-rename: same deptId-set account WITHOUT data_scope.unrestricted still falls back to the legacy deptId scope (behaviour preserved for genuinely scoped roles)", async () => {
  const { mod } = loadAuth({
    users: [baseUser("ADMINISTRATION", { deptId: "dept-cb" })],
    rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: true }],
  });
  const session: Session = { id: USER_ID, username: "tranmai", fullName: "Trần Mai", role: "ADMINISTRATION", deptId: "dept-cb" };
  assertScopeEquals(await mod.getUserScope(session), ["dept-cb"], "without data_scope.unrestricted, the legacy deptId fallback must still apply — this defense-in-depth is unchanged");
});

/* ------------------------------------------------------------------ *
 * "Mutable role name changed repeatedly -> no authorization behaviour
 * change" — proven structurally: neither hasPermission() nor
 * getUserScope() ever read roles.name for a decision, under ANY value.
 * ------------------------------------------------------------------ */

test("RBAC role-rename: repeatedly relabeling has zero effect because authorization never depends on any display-name value", async () => {
  const names = ["Administration", "C&B - Code DW", "Nhân sự C&B", "Bất kỳ tên nào khác"];
  for (const _name of names) {
    // The role's NAME never appears in a Session, in role_permissions, or in
    // any function signature auth.ts exposes — there is no parameter to even
    // FEED a display name into these checks. This loop demonstrates that no
    // matter what a role is currently displayed as, the same role KEY +
    // permission state produces the same outcome every time.
    const { mod } = loadAuth({
      users: [baseUser("ADMINISTRATION")],
      rolePermissionRows: [{ role: "ADMINISTRATION", permissionKey: "dw.view", allowed: true }],
    });
    await loginAs(mod, baseUser("ADMINISTRATION"));
    const guard = await mod.requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "dw.view");
    assert.equal(guard.ok, true, `outcome must be identical regardless of the role's current display name (${_name})`);
  }
});
