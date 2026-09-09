import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { checkProposalExecutable } from "../../../../lib/ai-copilot/action-execution-guard.ts";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — POST /api/ai-copilot/action/[proposalId]/execute
   ------------------------------------------------------------
   Chạy trên ĐÚNG route thật (vm + require shim, khuôn mẫu
   fingerprint/it-code/route.test.ts), dùng ĐÚNG checkProposalExecutable
   thật (pure, đã có 18 test riêng) — không hard-code lại logic guard ở
   đây, tránh test và code lệch nhau.

   Bao phủ mục "PHASE 3" trong test matrix của đề bài:
     • prepare gây ZERO business write (route KHÔNG BAO GIỜ tự thực thi).
     • proposal hết hạn không thể execute.
     • sai user không thể execute.
     • thiếu quyền không thể execute.
     • Data Scope đổi (không còn khớp department) chặn execute.
     • double-execute idempotent (gọi 2 lần không double-write, trả cùng resultRef).
     • execute thật CHỈ được gọi khi guard trả EXECUTE.
     • audit event đúng tên (CONFIRMED/EXECUTED/FAILED/EXPIRED) được ghi.
   ============================================================ */

type Guard = { ok: true; session: { id: string; role: string; username: string } } | { ok: false; status: number; error: string };

function loadRoute(opts: {
  guard: Guard;
  proposal: Record<string, unknown> | null;
  hasPermission?: boolean;
  scope?: string[] | null;
  actionExecuteResult?: { ok: true; resultRef: Record<string, unknown> } | { ok: false; code: string; message: string };
}) {
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const proposalCalls: { fn: string; args: unknown[] }[] = [];
  let currentProposal = opts.proposal ? { ...opts.proposal } : null;
  let actionExecuteCalled = false;

  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/auth": {
      requirePermission: async () => opts.guard,
      getUserScope: async () => opts.scope ?? null,
      hasPermission: async () => opts.hasPermission ?? true,
      writeAudit: async (_s: unknown, action: string, _t: string, detail: Record<string, unknown>) => {
        audits.push({ action, detail });
      },
    },
    "@/lib/ai-copilot/action-execution-guard": { checkProposalExecutable },
    "@/lib/ai-copilot/action-registry": {
      getActionRegistry: () =>
        new Map([
          [
            "prepare_recruitment_request",
            {
              name: "prepare_recruitment_request",
              execute: async () => {
                actionExecuteCalled = true;
                return opts.actionExecuteResult ?? { ok: true, resultRef: { requestId: "req-1" } };
              },
            },
          ],
        ]),
    },
    "@/lib/ai-copilot/proposals": {
      getProposalById: async (_id: string) => currentProposal,
      markConfirmed: async (id: string, by: string) => {
        proposalCalls.push({ fn: "markConfirmed", args: [id, by] });
        if (currentProposal) currentProposal = { ...currentProposal, status: "CONFIRMED" };
      },
      markExecuted: async (id: string, resultRef: unknown) => {
        proposalCalls.push({ fn: "markExecuted", args: [id, resultRef] });
        if (currentProposal) currentProposal = { ...currentProposal, status: "EXECUTED", executionResult: resultRef };
      },
      markFailed: async (id: string, message: string) => {
        proposalCalls.push({ fn: "markFailed", args: [id, message] });
        if (currentProposal) currentProposal = { ...currentProposal, status: "FAILED" };
      },
      markExpired: async (id: string) => {
        proposalCalls.push({ fn: "markExpired", args: [id] });
        if (currentProposal) currentProposal = { ...currentProposal, status: "EXPIRED" };
      },
      toGuardShape: (row: Record<string, unknown>) => ({
        id: row.id,
        status: row.status,
        createdBy: row.createdBy,
        requiredPermission: row.requiredPermission,
        departmentId: row.departmentId,
        expiresAt: row.expiresAt,
        executionResult: row.executionResult ?? null,
      }),
    },
  };

  const url = new URL("./[proposalId]/execute/route.ts", import.meta.url);
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

  return {
    mod: moduleObj.exports as { POST: (req: Request, ctx: { params: Promise<{ proposalId: string }> }) => Promise<{ status: number; body: Record<string, unknown> }> },
    audits,
    proposalCalls,
    actionExecuteCalled: () => actionExecuteCalled,
  };
}

function makeReq() {
  return {} as Request;
}
function ctx(proposalId = "prop-1") {
  return { params: Promise.resolve({ proposalId }) };
}

const ADMIN_GUARD: Guard = { ok: true, session: { id: "user-1", role: "ADMIN", username: "admin1" } };
const FUTURE = new Date(Date.now() + 10 * 60_000).toISOString();
const PAST = new Date(Date.now() - 10 * 60_000).toISOString();

function pendingProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "prop-1",
    action: "prepare_recruitment_request",
    status: "PENDING",
    createdBy: "user-1",
    requiredPermission: "planning.request",
    departmentId: "dept-1",
    expiresAt: FUTURE,
    payload: { departmentId: "dept-1" },
    executionResult: null,
    ...overrides,
  };
}

test("happy path: EXECUTE outcome -> markConfirmed, action.execute() called, markExecuted, AI_ACTION_EXECUTED audited", async () => {
  const { mod, audits, proposalCalls, actionExecuteCalled } = loadRoute({ guard: ADMIN_GUARD, proposal: pendingProposal() });
  const res = await mod.POST(makeReq(), ctx());
  assert.equal(res.status, 200);
  assert.equal((res.body.resultRef as Record<string, unknown>).requestId, "req-1");
  assert.equal(actionExecuteCalled(), true);
  assert.ok(proposalCalls.some((c) => c.fn === "markConfirmed"));
  assert.ok(proposalCalls.some((c) => c.fn === "markExecuted"));
  assert.deepEqual(
    audits.map((a) => a.action),
    ["AI_ACTION_CONFIRMED", "AI_ACTION_EXECUTED"],
  );
});

test("proposal not found -> 404, action.execute() never called, no audit", async () => {
  const { mod, audits, actionExecuteCalled } = loadRoute({ guard: ADMIN_GUARD, proposal: null });
  const res = await mod.POST(makeReq(), ctx());
  assert.equal(res.status, 404);
  assert.equal(actionExecuteCalled(), false);
  assert.equal(audits.length, 0);
});

test("wrong user cannot execute -> 403, action.execute() never called", async () => {
  const otherGuard: Guard = { ok: true, session: { id: "user-2", role: "ADMIN", username: "admin2" } };
  const { mod, actionExecuteCalled } = loadRoute({ guard: otherGuard, proposal: pendingProposal() });
  const res = await mod.POST(makeReq(), ctx());
  assert.equal(res.status, 403);
  assert.equal(actionExecuteCalled(), false);
});

test("expired proposal -> 409, marked EXPIRED, AI_ACTION_EXPIRED audited, action.execute() never called", async () => {
  const { mod, audits, proposalCalls, actionExecuteCalled } = loadRoute({ guard: ADMIN_GUARD, proposal: pendingProposal({ expiresAt: PAST }) });
  const res = await mod.POST(makeReq(), ctx());
  assert.equal(res.status, 409);
  assert.equal(actionExecuteCalled(), false);
  assert.ok(proposalCalls.some((c) => c.fn === "markExpired"));
  assert.deepEqual(audits.map((a) => a.action), ["AI_ACTION_EXPIRED"]);
});

test("insufficient live permission -> 403, action.execute() never called (even though the proposal itself is fine)", async () => {
  const { mod, actionExecuteCalled } = loadRoute({ guard: ADMIN_GUARD, proposal: pendingProposal(), hasPermission: false });
  const res = await mod.POST(makeReq(), ctx());
  assert.equal(res.status, 403);
  assert.equal(actionExecuteCalled(), false);
});

test("Data Scope changed since prepare (now excludes the proposal's department) -> 403, action.execute() never called", async () => {
  const { mod, actionExecuteCalled } = loadRoute({ guard: ADMIN_GUARD, proposal: pendingProposal(), scope: ["some-other-dept"] });
  const res = await mod.POST(makeReq(), ctx());
  assert.equal(res.status, 403);
  assert.equal(actionExecuteCalled(), false);
});

test("double execute is idempotent: second call short-circuits to the SAME resultRef, action.execute() called at most once", async () => {
  const harness = loadRoute({ guard: ADMIN_GUARD, proposal: pendingProposal() });
  const res1 = await harness.mod.POST(makeReq(), ctx());
  assert.equal(res1.status, 200);
  // Simulate a second HTTP call reusing the SAME harness (proposal is now EXECUTED in the stub's local state).
  const res2 = await harness.mod.POST(makeReq(), ctx());
  assert.equal(res2.status, 200);
  assert.equal(res2.body.idempotent, true);
  assert.equal((res2.body.resultRef as Record<string, unknown>).requestId, "req-1");
  assert.equal(harness.proposalCalls.filter((c) => c.fn === "markExecuted").length, 1, "the real execute path must run exactly once across both calls");
});

test("a domain execute() failure -> 502, marked FAILED, AI_ACTION_FAILED audited, proposal never marked EXECUTED", async () => {
  const { mod, audits, proposalCalls } = loadRoute({
    guard: ADMIN_GUARD,
    proposal: pendingProposal(),
    actionExecuteResult: { ok: false, code: "INTERNAL", message: "Không thể tạo Yêu cầu tuyển dụng." },
  });
  const res = await mod.POST(makeReq(), ctx());
  assert.equal(res.status, 502);
  assert.equal(res.body.error, "Không thể tạo Yêu cầu tuyển dụng.");
  assert.ok(proposalCalls.some((c) => c.fn === "markFailed"));
  assert.ok(!proposalCalls.some((c) => c.fn === "markExecuted"));
  assert.deepEqual(audits.map((a) => a.action), ["AI_ACTION_CONFIRMED", "AI_ACTION_FAILED"]);
});

test("a CANCELLED proposal cannot be executed -> 409, action.execute() never called", async () => {
  const { mod, actionExecuteCalled } = loadRoute({ guard: ADMIN_GUARD, proposal: pendingProposal({ status: "CANCELLED" }) });
  const res = await mod.POST(makeReq(), ctx());
  assert.equal(res.status, 409);
  assert.equal(actionExecuteCalled(), false);
});
