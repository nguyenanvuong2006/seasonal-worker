/**
 * BATCH PERMISSION EDITOR — /api/admin/permissions regression suite.
 *
 * Loads the REAL route.ts (POST batch_update_permissions + toggle) AND the
 * REAL src/lib/rbac.ts (isKnownRoleKey/upsertRolePermission) via the repo's
 * vm-sandbox loadModule pattern, sharing ONE fake db across both — so the
 * test proves the actual integration: one transaction, one cache
 * invalidation, one audit row, real role/permission validation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, eqValue, type FakeDb, type QueryCall } from "../../../../lib/test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../../../../lib/test-support/load-module.ts";
import * as rbacCatalog from "../../../../lib/rbac-catalog.ts";

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const routeJs = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  permissions: makeTable("permissions"),
  rolePermissions: makeTable("role_permissions"),
  roles: makeTable("roles"),
  users: makeTable("users"),
};

type RolePermRow = { id: string; role: string; permissionKey: string; allowed: boolean };
type RoleRow = { id: string; key: string; name: string; isSystem: boolean; isActive: boolean };

type Options = {
  guardRole?: string; // role of the acting admin session; undefined = ADMIN with rbac.manage
  denied?: boolean; // simulate requirePermission failing (401/403)
  rolePermissionRows?: RolePermRow[];
  roleRows?: RoleRow[];
  /** Throw when an update/insert touches this permissionKey — simulates a mid-batch DB failure. */
  failOnPermissionKey?: string;
};

type Context = {
  POST: (req: Request) => Promise<{ status: number; body: string }>;
  db: FakeDb;
  invalidateCalls: number;
  auditCalls: { action: string; targetType: string; details: Record<string, unknown> }[];
};

let nextRpId = 1;

function makeContext(opts: Options = {}): Context {
  let rows: RolePermRow[] = (opts.rolePermissionRows ?? []).map((r) => ({ ...r }));
  const roleRows: RoleRow[] = opts.roleRows ?? [];
  const invalidateCalls = { n: 0 };
  const auditCalls: Context["auditCalls"] = [];

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "roles") {
        const wantedKey = eqValue(call, "roles.key");
        return roleRows.filter((r) => r.key === wantedKey).map((r) => ({ id: r.key }));
      }
      if (call.root === "select" && call.table === "role_permissions") {
        const role = eqValue(call, "role_permissions.role");
        const permissionKey = eqValue(call, "role_permissions.permissionKey");
        return rows.filter((r) => r.role === role && r.permissionKey === permissionKey);
      }
      if (call.root === "update" && call.table === "role_permissions") {
        const id = eqValue(call, "role_permissions.id");
        const target = rows.find((r) => r.id === id);
        if (target && opts.failOnPermissionKey && target.permissionKey === opts.failOnPermissionKey) {
          throw new Error(`SIMULATED_DB_FAILURE:${target.permissionKey}`);
        }
        const patch = call.ops.find((o) => o.fn === "set")?.args[0] as { allowed?: boolean } | undefined;
        if (target && patch) target.allowed = Boolean(patch.allowed);
        return { rowCount: target ? 1 : 0 };
      }
      if (call.root === "insert" && call.table === "role_permissions") {
        const values = call.ops.find((o) => o.fn === "values")?.args[0] as { role: string; permissionKey: string; allowed: boolean };
        if (opts.failOnPermissionKey && values.permissionKey === opts.failOnPermissionKey) {
          throw new Error(`SIMULATED_DB_FAILURE:${values.permissionKey}`);
        }
        const row = { id: `rp-${nextRpId++}`, ...values };
        rows.push(row);
        return [row];
      }
      return undefined;
    },
  });

  const guardSession = { id: "admin-1", username: "admin1", fullName: "Admin", role: opts.guardRole ?? "ADMIN", deptId: null };

  const rbacModule = loadModule(new URL("../../../../lib/rbac.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/rbac-catalog": rbacCatalog,
    },
  });

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return {
            NextResponse: {
              json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body: JSON.stringify(body) }),
            },
          };
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/auth":
          return {
            requirePermission: async () =>
              opts.denied
                ? { ok: false as const, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." }
                : { ok: true as const, session: guardSession },
            invalidatePermissionCache: () => {
              invalidateCalls.n += 1;
            },
            writeAudit: async (_session: unknown, action: string, targetType: string, details: Record<string, unknown>) => {
              auditCalls.push({ action, targetType, details });
            },
          };
        case "@/lib/rbac-catalog":
          return rbacCatalog;
        case "@/lib/rbac":
          return rbacModule;
        default:
          throw new Error(`Unexpected require("${id}") — route must not depend on this module.`);
      }
    },
    process,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    console,
    Date,
    JSON,
    Array,
    Object,
    Number,
    Boolean,
    String,
    Set,
    Map,
    Math,
    RegExp,
  });
  vm.runInContext(routeJs, context);
  return {
    POST: (moduleObj.exports as { POST: Context["POST"] }).POST,
    db,
    get invalidateCalls() {
      return invalidateCalls.n;
    },
    auditCalls,
  };
}

function postRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/permissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROLE_ROWS: RoleRow[] = [{ id: "r1", key: "ADMINISTRATION", name: "C&B - Code DW", isSystem: false, isActive: true }];

/* ------------------------------------------------------------------ *
 * 1/2/3 — batch save applies every change in ONE request.
 * ------------------------------------------------------------------ */

test("batch_update_permissions: one request applies multiple permission changes for one role", async () => {
  const ctx = makeContext({
    roleRows: ROLE_ROWS,
    rolePermissionRows: [{ id: "rp-1", role: "ADMINISTRATION", permissionKey: "dw.view", allowed: false }],
  });
  const res = await ctx.POST(
    postRequest({
      action: "batch_update_permissions",
      role: "ADMINISTRATION",
      changes: [
        { permissionKey: "dw.view", allowed: true },
        { permissionKey: "meal.view", allowed: true },
        { permissionKey: "meal.export", allowed: true },
      ],
    }),
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.success, true);
  assert.equal(body.applied, 3);
  assert.equal(body.enabledCount, 3);
  assert.equal(body.disabledCount, 0);
  // Exactly one transaction for the whole batch — never one write-round-trip per permission.
  assert.equal(ctx.db.transactions, 1);
});

test("batch_update_permissions: cache invalidated exactly ONCE per batch, not once per change", async () => {
  const ctx = makeContext({ roleRows: ROLE_ROWS, rolePermissionRows: [] });
  await ctx.POST(
    postRequest({
      action: "batch_update_permissions",
      role: "ADMINISTRATION",
      changes: [
        { permissionKey: "dw.view", allowed: true },
        { permissionKey: "meal.view", allowed: true },
        { permissionKey: "meal.export", allowed: true },
        { permissionKey: "fingerprint.view", allowed: true },
      ],
    }),
  );
  assert.equal(ctx.invalidateCalls, 1);
});

test("batch_update_permissions: writes ONE audit row for the whole batch with structured counts + changed keys, not one per permission", async () => {
  const ctx = makeContext({ roleRows: ROLE_ROWS, rolePermissionRows: [] });
  await ctx.POST(
    postRequest({
      action: "batch_update_permissions",
      role: "ADMINISTRATION",
      changes: [
        { permissionKey: "dw.view", allowed: true },
        { permissionKey: "meal.view", allowed: true },
        { permissionKey: "meal.export", allowed: false },
      ],
    }),
  );
  assert.equal(ctx.auditCalls.length, 1);
  const [audit] = ctx.auditCalls;
  assert.equal(audit.action, "BATCH_UPDATE_ROLE_PERMISSIONS");
  assert.equal(audit.targetType, "role_permissions");
  assert.equal(audit.details.role, "ADMINISTRATION");
  assert.equal(audit.details.enabledCount, 2);
  assert.equal(audit.details.disabledCount, 1);
  assert.deepEqual([...(audit.details.changedKeys as string[])].sort(), ["dw.view", "meal.export", "meal.view"]);
});

/* ------------------------------------------------------------------ *
 * 4 — failed mutation rolls back / never signals partial success.
 * ------------------------------------------------------------------ */

test("batch_update_permissions: a mid-batch DB failure returns an error and produces NO cache invalidation, NO audit row, NO success response (never a partially-applied signal)", async () => {
  const ctx = makeContext({
    roleRows: ROLE_ROWS,
    rolePermissionRows: [],
    failOnPermissionKey: "meal.export", // the 2nd of 3 changes fails
  });
  const res = await ctx.POST(
    postRequest({
      action: "batch_update_permissions",
      role: "ADMINISTRATION",
      changes: [
        { permissionKey: "dw.view", allowed: true },
        { permissionKey: "meal.export", allowed: true },
        { permissionKey: "meal.view", allowed: true },
      ],
    }),
  );
  assert.equal(res.status, 500, "a failed batch must surface as an error, never 200");
  assert.equal(ctx.invalidateCalls, 0, "cache must not be invalidated for a failed batch");
  assert.equal(ctx.auditCalls.length, 0, "no audit row for a failed batch");
});

/* ------------------------------------------------------------------ *
 * 5 handled client-side (Cancel restores draft from baseline) — see
 * the dedicated frontend note in the final report; this suite covers the
 * server contract only.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 9 — unauthorized user receives 403.
 * ------------------------------------------------------------------ */

test("batch_update_permissions: a caller without rbac.manage receives 403, zero writes", async () => {
  const ctx = makeContext({ denied: true, roleRows: ROLE_ROWS, rolePermissionRows: [] });
  const res = await ctx.POST(
    postRequest({ action: "batch_update_permissions", role: "ADMINISTRATION", changes: [{ permissionKey: "dw.view", allowed: true }] }),
  );
  assert.equal(res.status, 403);
  assert.equal(ctx.db.writes.length, 0);
  assert.equal(ctx.invalidateCalls, 0);
});

/* ------------------------------------------------------------------ *
 * 10 — invalid role / invalid permission is rejected.
 * ------------------------------------------------------------------ */

test("batch_update_permissions: an unknown role key is rejected (never trusts role from the client)", async () => {
  const ctx = makeContext({ roleRows: [], rolePermissionRows: [] }); // "NOT_A_REAL_ROLE" exists nowhere
  const res = await ctx.POST(
    postRequest({ action: "batch_update_permissions", role: "NOT_A_REAL_ROLE", changes: [{ permissionKey: "dw.view", allowed: true }] }),
  );
  assert.equal(res.status, 400);
  assert.equal(ctx.db.writes.length, 0);
});

test("batch_update_permissions: an invalid permissionKey shape is rejected before any write", async () => {
  const ctx = makeContext({ roleRows: ROLE_ROWS, rolePermissionRows: [] });
  const res = await ctx.POST(
    postRequest({ action: "batch_update_permissions", role: "ADMINISTRATION", changes: [{ permissionKey: "not a valid key!!", allowed: true }] }),
  );
  assert.equal(res.status, 400);
  assert.equal(ctx.db.writes.length, 0);
});

test("batch_update_permissions: empty changes array is rejected", async () => {
  const ctx = makeContext({ roleRows: ROLE_ROWS, rolePermissionRows: [] });
  const res = await ctx.POST(postRequest({ action: "batch_update_permissions", role: "ADMINISTRATION", changes: [] }));
  assert.equal(res.status, 400);
});

/* ------------------------------------------------------------------ *
 * 11 — protected/system invariants remain valid: ADMIN can never be
 * configured via the batch endpoint either (mirrors the single toggle).
 * ------------------------------------------------------------------ */

test("batch_update_permissions: role=ADMIN is always rejected — ADMIN bypasses, never configurable, batch or not", async () => {
  const ctx = makeContext({ roleRows: ROLE_ROWS, rolePermissionRows: [] });
  const res = await ctx.POST(
    postRequest({ action: "batch_update_permissions", role: "ADMIN", changes: [{ permissionKey: "rbac.manage", allowed: false }] }),
  );
  assert.equal(res.status, 400);
  assert.equal(ctx.db.writes.length, 0);
});

/* ------------------------------------------------------------------ *
 * 12 — role rename does not affect batch permission editing: the batch
 * endpoint is keyed on role.key (a plain string identity), never role.name.
 * Renaming only touches roles.name — a column this route never reads.
 * ------------------------------------------------------------------ */

test("role rename safety: the batch endpoint operates on role KEY only — it never reads or requires a role display name", async () => {
  assert.doesNotMatch(routeSource, /roles\.name|role\.name/, "batch/ toggle logic must never branch on a role's display name");
  const ctx = makeContext({
    // The role's `name` is irrelevant to this endpoint — only `key` (ROLE_ROWS[0].key)
    // is ever consulted, exactly as it would be after "Administration" was renamed to
    // "C&B - Code DW" without touching the key.
    roleRows: [{ id: "r1", key: "ADMINISTRATION", name: "C&B - Code DW", isSystem: false, isActive: true }],
    rolePermissionRows: [{ id: "rp-1", role: "ADMINISTRATION", permissionKey: "dw.view", allowed: false }],
  });
  const res = await ctx.POST(
    postRequest({ action: "batch_update_permissions", role: "ADMINISTRATION", changes: [{ permissionKey: "dw.view", allowed: true }] }),
  );
  assert.equal(res.status, 200);
});

/* ------------------------------------------------------------------ *
 * De-duplication: the same permissionKey twice in one payload keeps the
 * last value and is applied exactly once.
 * ------------------------------------------------------------------ */

test("batch_update_permissions: a duplicated permissionKey in one payload is applied once, using the last value", async () => {
  const ctx = makeContext({ roleRows: ROLE_ROWS, rolePermissionRows: [] });
  const res = await ctx.POST(
    postRequest({
      action: "batch_update_permissions",
      role: "ADMINISTRATION",
      changes: [
        { permissionKey: "dw.view", allowed: true },
        { permissionKey: "dw.view", allowed: false },
      ],
    }),
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.applied, 1);
  assert.equal(body.enabledCount, 0);
  assert.equal(body.disabledCount, 1);
});

/* ------------------------------------------------------------------ *
 * PERMISSION CATALOG CONSISTENCY — "planning.columns.manage" bug.
 *
 * planning.reallocate / planning.columns.manage / planning.comment were
 * inserted directly into the `permissions`/`role_permissions` tables by
 * migrations/2026-08-17-planning-recruitment-upgrade.sql, so GET returned
 * them and the UI rendered toggles for them — but they were never added to
 * PERMISSION_CATALOG (rbac-catalog.ts), so getCatalogPermission() didn't
 * know them and batch/toggle validation rejected any save touching one of
 * them with "Permission key không hợp lệ". Fixed by adding all three to
 * PERMISSION_CATALOG (see src/lib/rbac.test.ts's whole-source-tree catalog
 * consistency audit for the general-case regression test).
 * ------------------------------------------------------------------ */

test("batch_update_permissions: a batch that touches planning.columns.manage (the exact reported bug) now succeeds", async () => {
  const ctx = makeContext({ roleRows: ROLE_ROWS, rolePermissionRows: [] });
  const res = await ctx.POST(
    postRequest({
      action: "batch_update_permissions",
      role: "ADMINISTRATION",
      changes: [
        { permissionKey: "dw.view", allowed: true },
        { permissionKey: "planning.columns.manage", allowed: true },
        { permissionKey: "planning.reallocate", allowed: true },
        { permissionKey: "planning.comment", allowed: true },
      ],
    }),
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.applied, 4);
  assert.equal(ctx.invalidateCalls, 1);
  assert.equal(ctx.auditCalls.length, 1);
});

test("batch_update_permissions: EVERY permission in the canonical catalog can be saved for one role in a single batch (whole-catalog 'Bật tất cả' scenario)", async () => {
  const ctx = makeContext({ roleRows: ROLE_ROWS, rolePermissionRows: [] });
  const changes = rbacCatalog.PERMISSION_CATALOG.map((p) => ({ permissionKey: p.key, allowed: true }));
  const res = await ctx.POST(postRequest({ action: "batch_update_permissions", role: "ADMINISTRATION", changes }));
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.applied, rbacCatalog.PERMISSION_CATALOG.length);
  assert.equal(ctx.invalidateCalls, 1);
  assert.equal(ctx.auditCalls.length, 1);
});

test("batch_update_permissions: a genuinely unknown deeply-dotted key is still rejected — catalog membership gates it, not just the key-shape regex", async () => {
  const ctx = makeContext({ roleRows: ROLE_ROWS, rolePermissionRows: [] });
  const res = await ctx.POST(
    postRequest({
      action: "batch_update_permissions",
      role: "ADMINISTRATION",
      changes: [{ permissionKey: "totally.fake.permission.key", allowed: true }],
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(ctx.db.writes.length, 0);
});

/* ------------------------------------------------------------------ *
 * PHASE 4 — the 28-change scenario: an invalid key anywhere in the batch
 * is rejected BEFORE db.transaction() is ever opened (validation runs over
 * the whole payload first), so there is nothing to roll back — zero writes
 * are ever attempted, not "written then undone".
 * ------------------------------------------------------------------ */

test("batch_update_permissions: a 28-change batch with ONE invalid key rejects the WHOLE batch pre-transaction — zero writes attempted, zero transactions opened", async () => {
  const ctx = makeContext({ roleRows: ROLE_ROWS, rolePermissionRows: [] });
  const validKeys = rbacCatalog.PERMISSION_CATALOG.slice(0, 27).map((p) => p.key);
  const changes = [...validKeys.map((permissionKey) => ({ permissionKey, allowed: true })), { permissionKey: "not.a.real.permission", allowed: true }];
  assert.equal(changes.length, 28);
  const res = await ctx.POST(postRequest({ action: "batch_update_permissions", role: "ADMINISTRATION", changes }));
  assert.equal(res.status, 400);
  assert.equal(ctx.db.writes.length, 0, "no write of any kind must be attempted — the invalid key is caught before db.transaction() opens");
  assert.equal(ctx.db.transactions, 0, "db.transaction() must never be entered when validation fails");
  assert.equal(ctx.invalidateCalls, 0);
  assert.equal(ctx.auditCalls.length, 0);
});
