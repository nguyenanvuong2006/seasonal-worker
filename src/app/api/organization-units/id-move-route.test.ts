import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — POST /api/organization-units/[id]/move
   ------------------------------------------------------------
   File test này CỐ Ý đặt PHẲNG (không nằm trong thư mục [id]/move/)
   — `node --test` diễn giải mọi đường dẫn truyền vào như GLOB PATTERN,
   nên 1 thư mục tên "[id]" (dynamic route Next.js) bị hiểu thành
   character-class glob và KHÔNG BAO GIỜ được `npm test` phát hiện nếu
   file .test.ts nằm bên trong đó (âm thầm không chạy — nguy hiểm hơn
   fail rõ ràng). readFileSync bên dưới vẫn trỏ đúng vào route.ts thật
   qua đường dẫn tương đối — chỉkhông đặt CHÍNH file .test.ts trong đó.

   Bao phủ (mục 24 đề bài — CASE 5/6: circular parent / tự làm cha
   chính mình), ở tầng route: lỗi từ service phải trả 400 rõ ràng,
   KHÔNG bao giờ 200 khi service từ chối.
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
  moveImpl?: (input: Record<string, unknown>) => Record<string, unknown>;
}) {
  const url = new URL("./[id]/move/route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const moveCalls: Record<string, unknown>[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
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
      moveOrganizationUnit: async (input: Record<string, unknown>) => {
        moveCalls.push(input);
        if (opts.moveImpl) return opts.moveImpl(input);
        return { id: input.id, parentId: input.newParentId, path: "root.moved" };
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

  return { mod: moduleObj.exports, moveCalls, audits };
}

function makeReq(body: unknown) {
  return { json: async () => body } as unknown as Request;
}
function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

test("Thiếu newParentId -> 400, không gọi service", async () => {
  const { mod, moveCalls } = loadRoute({});
  const POST = mod.POST as (req: Request, ctx: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({}), makeCtx("node-1"));
  assert.equal(res.status, 400);
  assert.equal(moveCalls.length, 0);
});

test("CASE 5/6 — circular parent / tự làm cha chính mình: service từ chối -> route trả 400, KHÔNG 200", async () => {
  const { mod } = loadRoute({
    moveImpl: () => {
      throw new OrgTreeErrorStub(
        "Không thể di chuyển một đơn vị vào làm con của chính nó hoặc của một đơn vị con cháu của nó (sẽ tạo vòng lặp).",
        "CIRCULAR_PARENT",
      );
    },
  });
  const POST = mod.POST as (req: Request, ctx: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ newParentId: "descendant-of-node-1" }), makeCtx("node-1"));

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "CIRCULAR_PARENT");
  assert.match(res.body.error as string, /vòng lặp/);
});

test("Move hợp lệ -> 200, delegate đúng id + newParentId, ghi audit với path mới", async () => {
  const { mod, moveCalls, audits } = loadRoute({});
  const POST = mod.POST as (req: Request, ctx: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  const res = await POST(makeReq({ newParentId: "parent-2" }), makeCtx("node-1"));

  assert.equal(res.status, 200);
  assert.equal(moveCalls.length, 1);
  assert.equal(moveCalls[0].id, "node-1");
  assert.equal(moveCalls[0].newParentId, "parent-2");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "MOVE_ORGANIZATION_UNIT");
});
