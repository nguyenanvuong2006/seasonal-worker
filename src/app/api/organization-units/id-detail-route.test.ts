import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET/PATCH /api/organization-units/[id]
   ------------------------------------------------------------
   File test CỐ Ý đặt PHẲNG — xem giải thích trong id-move-route.test.ts
   (thư mục "[id]" bị `node --test` diễn giải thành glob character-class,
   file .test.ts đặt bên trong sẽ ÂM THẦM không bao giờ chạy).

   Bao phủ:
     • GET lắp ráp đúng breadcrumb + counts.
     • PATCH action=DEACTIVATE/REACTIVATE dispatch đúng hàm — KHÔNG có
       action DELETE nào tồn tại (xoá cứng bị chặn hoàn toàn — mục 4, 23).
     • Permission gating dùng chung departments.manage.
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

class OrgTreeErrorStub extends Error {
  code: string;
  constructor(message: string, code = "ORG_TREE_RULE") {
    super(message);
    this.code = code;
  }
}

function loadRoute(opts: {
  guardFor?: (roles: string[], key: string) => Guard;
  unit?: Record<string, unknown> | null;
  deactivateImpl?: () => Record<string, unknown>;
}) {
  const url = new URL("./[id]/route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const calls: { fn: string; args: unknown[] }[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };
  const unit = opts.unit ?? { id: "node-1", name: "Chrysanthemums", legacyDepartmentId: null, parentId: "parent-1" };

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: {
        json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
      },
    },
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => (opts.guardFor ? opts.guardFor(roles, key) : ADMIN_GUARD),
      writeAudit: async (_s: unknown, action: string, _t: string, detail: Record<string, unknown>) => {
        audits.push({ action, detail });
      },
    },
    "@/lib/helpers": { todayStr: () => "2026-08-17" },
    "@/lib/organization-units": {
      OrgTreeError: OrgTreeErrorStub,
      getUnit: async (id: string) => {
        calls.push({ fn: "getUnit", args: [id] });
        return opts.unit === null ? null : unit;
      },
      getBreadcrumb: async (id: string) => {
        calls.push({ fn: "getBreadcrumb", args: [id] });
        return [{ id: "root", name: "Dalat Hasfarm" }, { id, name: unit.name }];
      },
      getDescendants: async (id: string) => {
        calls.push({ fn: "getDescendants", args: [id] });
        return [unit, { id: "child-1", parentId: id }];
      },
      countActiveWorkers: async () => 3,
      countActiveRecruitmentRequests: async () => 1,
      countTodayApplications: async () => 2,
      updateOrganizationUnit: async (input: Record<string, unknown>) => {
        calls.push({ fn: "updateOrganizationUnit", args: [input] });
        return { ...unit, name: input.name ?? unit.name };
      },
      deactivateOrganizationUnit: async (input: Record<string, unknown>) => {
        calls.push({ fn: "deactivateOrganizationUnit", args: [input] });
        return opts.deactivateImpl ? opts.deactivateImpl() : { ...unit, isActive: false };
      },
      reactivateOrganizationUnit: async (input: Record<string, unknown>) => {
        calls.push({ fn: "reactivateOrganizationUnit", args: [input] });
        return { ...unit, isActive: true };
      },
    },
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

  return { mod: moduleObj.exports, calls, audits };
}

function makeReq(body?: unknown) {
  return { json: async () => body } as unknown as Request;
}
function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

test("GET: không tìm thấy -> 404", async () => {
  const { mod } = loadRoute({ unit: null });
  const GET = mod.GET as (req: Request, ctx: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(), makeCtx("missing"));
  assert.equal(res.status, 404);
});

test("GET: lắp ráp đúng breadcrumb + childCount + counts", async () => {
  const { mod } = loadRoute({});
  const GET = mod.GET as (req: Request, ctx: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET(makeReq(), makeCtx("node-1"));

  assert.equal(res.status, 200);
  assert.equal((res.body.breadcrumb as unknown[]).length, 2);
  assert.equal(res.body.childCount, 1); // chỉ child-1 có parentId === "node-1"
  assert.equal(res.body.activeWorkers, 3);
  assert.equal(res.body.activeRequests, 1);
  assert.equal(res.body.todayApplications, 2);
});

test("PATCH action=DEACTIVATE -> gọi đúng deactivateOrganizationUnit, KHÔNG gọi updateOrganizationUnit", async () => {
  const { mod, calls, audits } = loadRoute({});
  const PATCH = mod.PATCH as (req: Request, ctx: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ action: "DEACTIVATE" }), makeCtx("node-1"));

  assert.equal(res.status, 200);
  assert.ok(calls.some((c) => c.fn === "deactivateOrganizationUnit"));
  assert.ok(!calls.some((c) => c.fn === "updateOrganizationUnit"));
  assert.equal(audits[0].action, "DEACTIVATE_ORGANIZATION_UNIT");
});

test("PATCH action=REACTIVATE -> gọi đúng reactivateOrganizationUnit", async () => {
  const { mod, calls } = loadRoute({});
  const PATCH = mod.PATCH as (req: Request, ctx: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ action: "REACTIVATE" }), makeCtx("node-1"));

  assert.equal(res.status, 200);
  assert.ok(calls.some((c) => c.fn === "reactivateOrganizationUnit"));
});

test("PATCH không có action -> sửa metadata qua updateOrganizationUnit", async () => {
  const { mod, calls } = loadRoute({});
  const PATCH = mod.PATCH as (req: Request, ctx: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await PATCH(makeReq({ name: "Tên mới" }), makeCtx("node-1"));

  assert.equal(res.status, 200);
  const updateCall = calls.find((c) => c.fn === "updateOrganizationUnit");
  assert.ok(updateCall);
  assert.equal((updateCall!.args[0] as Record<string, unknown>).name, "Tên mới");
});

test("Không có route DELETE nào được export — xoá cứng bị chặn hoàn toàn ở tầng route", async () => {
  const { mod } = loadRoute({});
  assert.equal(mod.DELETE, undefined);
});

test("Permission gating: role không hợp lệ -> 403 cho cả GET và PATCH", async () => {
  const denied: Guard = { ok: false, status: 403, error: "Từ chối truy cập! Quyền hạn không hợp lệ." };
  const { mod: getMod } = loadRoute({ guardFor: () => denied });
  const GET = getMod.GET as (req: Request, ctx: unknown) => Promise<{ status: number }>;
  assert.equal((await GET(makeReq(), makeCtx("node-1"))).status, 403);

  const { mod: patchMod } = loadRoute({ guardFor: () => denied });
  const PATCH = patchMod.PATCH as (req: Request, ctx: unknown) => Promise<{ status: number }>;
  assert.equal((await PATCH(makeReq({ action: "DEACTIVATE" }), makeCtx("node-1"))).status, 403);
});
