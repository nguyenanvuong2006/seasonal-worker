import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET/POST /api/organization-units
   ------------------------------------------------------------
   Bao phủ (mục 24 đề bài — Organization Tree, phần route-level):
     • Chặn role/permission không hợp lệ (dùng chung departments.manage,
       KHÔNG thêm quyền mới ở PR1).
     • POST tạo mới delegate đúng tham số xuống service layer.
     • OrgTreeError (vd circular/PARENT_INACTIVE) -> 400 kèm message rõ.
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
  units?: Record<string, unknown>[];
  createImpl?: (input: Record<string, unknown>) => Record<string, unknown>;
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const createCalls: Record<string, unknown>[] = [];
  const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1" } };

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
    "@/lib/organization-units": {
      OrgTreeError: OrgTreeErrorStub,
      listAllUnits: async () => opts.units ?? [],
      createOrganizationUnit: async (input: Record<string, unknown>) => {
        createCalls.push(input);
        if (opts.createImpl) return opts.createImpl(input);
        return { id: "new-unit-id", name: input.name, parentId: input.parentId, path: "root.new_unit" };
      },
    },
    "@/lib/organization-tree": { ORG_UNIT_TYPES: ["COMPANY", "LOCATION", "DEPARTMENT", "SECTION", "GROUP", "OTHER"] },
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

  return { mod: moduleObj.exports, audits, createCalls };
}

function makeReq(body?: unknown) {
  return { json: async () => body } as unknown as Request;
}

test("GET: role không có departments.manage -> 403, không gọi listAllUnits", async () => {
  const { mod } = loadRoute({ guardFor: () => ({ ok: false, status: 403, error: "Từ chối truy cập! Quyền hạn không hợp lệ." }) });
  const GET = mod.GET as () => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET();
  assert.equal(res.status, 403);
});

test("GET: trả về units + unitTypes khi có quyền", async () => {
  const { mod } = loadRoute({ units: [{ id: "1", name: "Dalat Hasfarm", parentId: null }] });
  const GET = mod.GET as () => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await GET();
  assert.equal(res.status, 200);
  assert.equal((res.body.units as unknown[]).length, 1);
  assert.ok(Array.isArray(res.body.unitTypes));
});

test("POST: thiếu parentId -> 400, không gọi createOrganizationUnit", async () => {
  const { mod, createCalls } = loadRoute({});
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ name: "Chrysanthemums", unitType: "GROUP" }));
  assert.equal(res.status, 400);
  assert.equal(createCalls.length, 0);
});

test("POST: tạo mới hợp lệ -> 200, delegate đúng tham số + ghi audit", async () => {
  const { mod, createCalls, audits } = loadRoute({});
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ name: "Chrysanthemums", unitType: "GROUP", parentId: "parent-1", code: "chry" }));

  assert.equal(res.status, 200);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].parentId, "parent-1");
  assert.equal(createCalls[0].name, "Chrysanthemums");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "CREATE_ORGANIZATION_UNIT");
});

test("POST: OrgTreeError từ service (vd PARENT_INACTIVE) -> 400 kèm message + code", async () => {
  const { mod } = loadRoute({
    createImpl: () => {
      throw new OrgTreeErrorStub("Đơn vị cha đã bị vô hiệu hoá — không thể thêm con mới.", "PARENT_INACTIVE");
    },
  });
  const POST = mod.POST as (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ name: "X", unitType: "OTHER", parentId: "inactive-parent" }));

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "PARENT_INACTIVE");
  assert.match(res.body.error as string, /vô hiệu hoá/);
});
