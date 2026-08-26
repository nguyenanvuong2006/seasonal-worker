import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { resolveAssignmentActorWrite } from "../../../lib/assignment-actor.ts";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — POST /api/bulk-import ("Duyệt & xếp việc")
   ------------------------------------------------------------
   Bao phủ PR #114 pre-merge blocker #1 (bulk import phải đóng
   băng assignment actor giống PATCH inline):

     • bulk PENDING → APPROVED (User A): daily_applications VÀ
       employment_sessions đều lưu assigned_by / assigned_by_display_name /
       assigned_at.
     • bulk đã APPROVED sẵn → KHÔNG ghi đè actor.
     • reset (REJECTED/WAITLIST) → re-APPROVE bởi User C → actor mới = C.
     • display name ưu tiên hơn username (qua centralized resolver).
     • deploy-order gate OFF → KHÔNG ghi actor (không phụ thuộc cột chưa
       migrate).
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string; fullName: string } }
  | { ok: false; status: number; error: string };

function loadRoute(opts: {
  guardFor: (roles: string[], key: string) => Guard;
  scope: string[] | null;
  apps: Record<string, unknown>[];
  conflicts?: { dailyApplicationId: string; activeDeptName: string | null }[];
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const appUpdates: { set: Record<string, unknown> }[] = [];
  const sessionUpdates: { set: Record<string, unknown> }[] = [];

  const txApi = {
    select: () => ({
      from: () => ({
        where: async () => opts.apps,
      }),
    }),
    execute: async () => ({ rows: opts.conflicts ?? [] }),
    update: (table: { __table?: string }) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          if (table.__table === "daily_applications") appUpdates.push({ set });
          else if (table.__table === "employment_sessions") sessionUpdates.push({ set });
          return {
            rowCount: 1,
            returning: async () => [{ id: "r1", deptId: null, startingDate: "2026-08-26" }],
          };
        },
      }),
    }),
  };

  const dbStub = {
    ...txApi,
    transaction: async (fn: (tx: typeof txApi) => Promise<unknown>) => fn(txApi),
  };

  const schemaStub = {
    dailyApplications: { __table: "daily_applications", id: { __col: "daily_applications.id" } },
    employmentSessions: { __table: "employment_sessions", dailyApplicationId: { __col: "employment_sessions.daily_application_id" } },
  };

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: {
        json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
      },
    },
    "drizzle-orm": {
      and: (...c: unknown[]) => ({ op: "and", c }),
      eq: (col: unknown, v: unknown) => ({ op: "eq", col, v }),
      inArray: (col: unknown, v: unknown) => ({ op: "inArray", col, v }),
      sql: Object.assign((strings: TemplateStringsArray, ...vals: unknown[]) => ({ op: "sql", strings, vals }), {
        raw: (s: string) => ({ op: "sqlRaw", s }),
        join: (vals: unknown[], sep: unknown) => ({ op: "sqlJoin", vals, sep }),
      }),
    },
    "@/db": { db: dbStub },
    "@/db/schema": schemaStub,
    "@/lib/auth": {
      requireRoleAndPermission: async (roles: string[], key: string) => opts.guardFor(roles, key),
      getUserScope: async () => opts.scope,
      writeAudit: async (_s: unknown, action: string, _t: string, detail: Record<string, unknown>) => {
        audits.push({ action, detail });
      },
    },
    "@/lib/data-scope": {
      scopeAllowsDepartment: (scope: string[] | null, deptId: string | null) => {
        if (scope === null) return true;
        if (!deptId) return false;
        return scope.includes(deptId);
      },
    },
    "@/lib/helpers": { todayStr: () => "2026-08-26" },
    "@/lib/person-name": { normalizePersonName: (s: string) => s },
    "@/lib/rule-engine": {
      loadActiveRules: async () => [],
      runRules: async () => [],
    },
    "@/lib/notifications": { queueNotification: async () => undefined },
    "@/lib/planning": { autoAllocateInternship: async () => undefined },
    "@/lib/validators": {
      isValidCccd: (s: string | null) => typeof s === "string" && /^\d{12}$/.test(s),
      normalizeCccd: (s: string | null) => s,
    },
    // Use the REAL centralized resolver so the env-var deploy-order gate and
    // the display-name resolver are exercised end-to-end.
    "@/lib/assignment-actor": { resolveAssignmentActorWrite },
  };

  const moduleObj = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`Unexpected require("${specifier}")`);
  };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: requireShim,
    console,
    process,
    Date,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Error,
    TypeError,
    RangeError,
    isNaN,
    parseInt,
    parseFloat,
    URL,
  });
  vm.runInContext(js, context);

  return { mod: moduleObj.exports, audits, appUpdates, sessionUpdates };
}

function makeReq(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

const ADMIN_GUARD: Guard = {
  ok: true,
  session: { id: "u1", role: "ADMIN", username: "anvuong", fullName: "Nguyễn An Vượng" },
};

const APP_ID = "11111111-1111-1111-1111-111111111111";

function pendingApp(status = "PENDING"): Record<string, unknown> {
  return {
    id: APP_ID,
    cccd: "010000000001",
    fullName: "Nguyen Van A",
    gender: "Nam",
    deptId: null,
    status,
    assignedBy: null,
    assignedByDisplayName: null,
    assignedAt: null,
  };
}

test("bulk PENDING → APPROVED (User A) freezes actor on BOTH tables", async () => {
  process.env.ASSIGNMENT_ACTOR_WRITE_ENABLED = "1";
  try {
    const { mod, appUpdates, sessionUpdates } = loadRoute({
      guardFor: () => ADMIN_GUARD,
      scope: null,
      apps: [pendingApp("PENDING")],
    });
    const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
    const res = await POST(makeReq({ ids: [APP_ID] }));

    assert.equal(res.status, 200);
    assert.equal(res.body.imported, 1);

    assert.equal(appUpdates.length, 1, "phải cập nhật daily_applications");
    const appSet = appUpdates[0].set;
    assert.equal(appSet.assignedBy, "anvuong");
    assert.equal(appSet.assignedByDisplayName, "Nguyễn An Vượng");
    assert.ok(appSet.assignedAt instanceof Date);

    assert.equal(sessionUpdates.length, 1, "phải cập nhật employment_sessions");
    const sessionSet = sessionUpdates[0].set;
    assert.equal(sessionSet.assignedBy, "anvuong");
    assert.equal(sessionSet.assignedByDisplayName, "Nguyễn An Vượng");
    assert.ok(sessionSet.assignedAt instanceof Date);
  } finally {
    delete process.env.ASSIGNMENT_ACTOR_WRITE_ENABLED;
  }
});

test("bulk đã APPROVED sẵn → KHÔNG ghi đè actor", async () => {
  process.env.ASSIGNMENT_ACTOR_WRITE_ENABLED = "1";
  try {
    const alreadyApproved = pendingApp("APPROVED");
    alreadyApproved.assignedBy = "tranmai";
    alreadyApproved.assignedByDisplayName = "Trần Mai";
    const { mod, appUpdates, sessionUpdates } = loadRoute({
      guardFor: () => ADMIN_GUARD,
      scope: null,
      apps: [alreadyApproved],
    });
    const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
    const res = await POST(makeReq({ ids: [APP_ID] }));

    assert.equal(res.status, 200);
    // Đã đúng trạng thái → bị skip (ok: false), không có UPDATE nào.
    const results = res.body.results as { ok: boolean }[];
    assert.equal(results[0].ok, false);
    assert.equal(appUpdates.length, 0, "không ghi đè daily_applications");
    assert.equal(sessionUpdates.length, 0, "không ghi đè employment_sessions");
  } finally {
    delete process.env.ASSIGNMENT_ACTOR_WRITE_ENABLED;
  }
});

test("reset (REJECTED) + re-approve bởi User C → actor mới = C", async () => {
  process.env.ASSIGNMENT_ACTOR_WRITE_ENABLED = "1";
  try {
    const resetApp = pendingApp("REJECTED");
    resetApp.assignedBy = "anvuong";
    resetApp.assignedByDisplayName = "Nguyễn An Vượng";
    const { mod, appUpdates } = loadRoute({
      guardFor: () => ADMIN_GUARD,
      scope: null,
      apps: [resetApp],
    });
    const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
    const res = await POST(makeReq({ ids: [APP_ID] }));

    assert.equal(res.status, 200);
    assert.equal(appUpdates.length, 1);
    // User C (operator hiện tại) là người re-approve → actor mới.
    assert.equal(appUpdates[0].set.assignedBy, "anvuong");
    assert.equal(appUpdates[0].set.assignedByDisplayName, "Nguyễn An Vượng");
  } finally {
    delete process.env.ASSIGNMENT_ACTOR_WRITE_ENABLED;
  }
});

test("deploy-order gate OFF → KHÔNG ghi actor (backward compatible)", async () => {
  // KHÔNG set ASSIGNMENT_ACTOR_WRITE_ENABLED (mặc định = tắt).
  const { mod, appUpdates, sessionUpdates } = loadRoute({
    guardFor: () => ADMIN_GUARD,
    scope: null,
    apps: [pendingApp("PENDING")],
  });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ ids: [APP_ID] }));

  assert.equal(res.status, 200);
  assert.equal(appUpdates.length, 1, "vẫn cập nhật trạng thái");
  assert.equal("assignedBy" in appUpdates[0].set, false, "không ghi assignedBy khi chưa migrate");
  assert.equal("assignedByDisplayName" in appUpdates[0].set, false);
  assert.equal("assignedAt" in appUpdates[0].set, false);
  assert.equal(sessionUpdates.length, 1);
  assert.equal("assignedBy" in sessionUpdates[0].set, false);
});
