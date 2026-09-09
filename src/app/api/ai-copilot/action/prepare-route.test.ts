import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — POST /api/ai-copilot/action/prepare
   ------------------------------------------------------------
   Chạy trên ĐÚNG route thật (vm + require shim). Bao phủ:
     • requirePermission gate trước tất cả.
     • rate limit 429.
     • action không tồn tại -> 400, KHÔNG tạo proposal.
     • thiếu requiredPermission cụ thể của action -> 403, KHÔNG tạo proposal.
     • parseArgs throw -> 400, KHÔNG tạo proposal.
     • validate() trả ok:false -> 400, KHÔNG tạo proposal (mission: "prepare
       causes ZERO business writes" — ở đây còn kiểm tra rộng hơn: validate
       thất bại thì cũng không tạo cả proposal bookkeeping row).
     • thành công: tạo đúng 1 proposal, ghi audit AI_ACTION_PROPOSED, KHÔNG
       gọi action.execute() (route này hoàn toàn không import execute()).
   ============================================================ */

type Guard = { ok: true; session: { id: string; role: string; username: string } } | { ok: false; status: number; error: string };

function loadRoute(opts: {
  guard: Guard;
  rateAllowed?: boolean;
  actionDef?: Record<string, unknown> | null;
  hasPermission?: boolean;
  validateResult?: { ok: true; payload: Record<string, unknown>; departmentId: string | null } | { ok: false; error: string };
}) {
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const createProposalCalls: Record<string, unknown>[] = [];

  const defaultAction = {
    name: "prepare_recruitment_request",
    requiredPermission: "planning.request",
    parseArgs: (raw: unknown) => raw,
    validate: async () => opts.validateResult ?? { ok: true, payload: { departmentId: "dept-1", maleRq: 1, femaleRq: 1 }, departmentId: "dept-1" },
    buildPreview: () => "ĐỀ XUẤT HÀNH ĐỘNG\n...",
  };

  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/ai/rate-limit": { checkAIRateLimit: () => (opts.rateAllowed === false ? { allowed: false, retryAfterSeconds: 9 } : { allowed: true, retryAfterSeconds: 0 }) },
    "@/lib/auth": {
      requirePermission: async () => opts.guard,
      getUserScope: async () => null,
      hasPermission: async () => opts.hasPermission ?? true,
      writeAudit: async (_s: unknown, action: string, _t: string, detail: Record<string, unknown>) => {
        audits.push({ action, detail });
      },
    },
    "@/lib/ai-copilot/action-registry": {
      getActionRegistry: () => new Map(opts.actionDef === null ? [] : [["prepare_recruitment_request", opts.actionDef ?? defaultAction]]),
    },
    "@/lib/ai-copilot/proposals": {
      createProposal: async (input: Record<string, unknown>) => {
        createProposalCalls.push(input);
        return { id: "prop-new-1", humanReadablePreview: input.humanReadablePreview, expiresAt: new Date(Date.now() + 900_000) };
      },
    },
  };

  const url = new URL("./prepare/route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
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

  return { mod: moduleObj.exports as { POST: (req: Request) => Promise<{ status: number; body: Record<string, unknown> }> }, audits, createProposalCalls };
}

function makeReq(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

const ADMIN_GUARD: Guard = { ok: true, session: { id: "user-1", role: "ADMIN", username: "admin1" } };
const DENIED_GUARD: Guard = { ok: false, status: 403, error: "Không có quyền." };

test("requirePermission denied -> exact status/error, no rate check, no proposal", async () => {
  const { mod, createProposalCalls } = loadRoute({ guard: DENIED_GUARD });
  const res = await mod.POST(makeReq({ action: "prepare_recruitment_request", args: {} }));
  assert.equal(res.status, 403);
  assert.equal(createProposalCalls.length, 0);
});

test("rate limited -> 429, no proposal created", async () => {
  const { mod, createProposalCalls } = loadRoute({ guard: ADMIN_GUARD, rateAllowed: false });
  const res = await mod.POST(makeReq({ action: "prepare_recruitment_request", args: {} }));
  assert.equal(res.status, 429);
  assert.equal(createProposalCalls.length, 0);
});

test("unknown action name -> 400, no proposal created", async () => {
  const { mod, createProposalCalls } = loadRoute({ guard: ADMIN_GUARD, actionDef: null });
  const res = await mod.POST(makeReq({ action: "not_a_real_action", args: {} }));
  assert.equal(res.status, 400);
  assert.equal(createProposalCalls.length, 0);
});

test("missing the action's specific required permission -> 403, no proposal created", async () => {
  const { mod, createProposalCalls } = loadRoute({ guard: ADMIN_GUARD, hasPermission: false });
  const res = await mod.POST(makeReq({ action: "prepare_recruitment_request", args: {} }));
  assert.equal(res.status, 403);
  assert.equal(createProposalCalls.length, 0);
});

test("parseArgs throwing -> 400 with the thrown message, no proposal created", async () => {
  const throwingAction = {
    name: "prepare_recruitment_request",
    requiredPermission: "planning.request",
    parseArgs: () => {
      throw new Error("maleRq và femaleRq phải là số không âm.");
    },
    validate: async () => ({ ok: true, payload: {}, departmentId: null }),
    buildPreview: () => "",
  };
  const { mod, createProposalCalls } = loadRoute({ guard: ADMIN_GUARD, actionDef: throwingAction });
  const res = await mod.POST(makeReq({ action: "prepare_recruitment_request", args: {} }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "maleRq và femaleRq phải là số không âm.");
  assert.equal(createProposalCalls.length, 0);
});

test("validate() returning ok:false -> 400 with its error, NO proposal created (zero writes, not even the bookkeeping row)", async () => {
  const { mod, createProposalCalls } = loadRoute({ guard: ADMIN_GUARD, validateResult: { ok: false, error: "Bộ phận này nằm ngoài Data Scope của bạn." } });
  const res = await mod.POST(makeReq({ action: "prepare_recruitment_request", args: {} }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Bộ phận này nằm ngoài Data Scope của bạn.");
  assert.equal(createProposalCalls.length, 0);
});

test("success: exactly one proposal created, AI_ACTION_PROPOSED audited, response carries proposalId + preview + expiry", async () => {
  const { mod, audits, createProposalCalls } = loadRoute({ guard: ADMIN_GUARD });
  const res = await mod.POST(makeReq({ action: "prepare_recruitment_request", args: { departmentId: "dept-1", maleRq: 1, femaleRq: 1 } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.proposalId, "prop-new-1");
  assert.equal(res.body.action, "prepare_recruitment_request");
  assert.ok(typeof res.body.humanReadablePreview === "string" && res.body.humanReadablePreview.length > 0);
  assert.ok(res.body.expiresAt);
  assert.equal(createProposalCalls.length, 1);
  assert.deepEqual(audits.map((a) => a.action), ["AI_ACTION_PROPOSED"]);
});
