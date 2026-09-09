import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — POST /api/ai-copilot/action/[proposalId]/cancel
   ============================================================ */

type Guard = { ok: true; session: { id: string; role: string; username: string } } | { ok: false; status: number; error: string };

function loadRoute(opts: { guard: Guard; proposal: Record<string, unknown> | null }) {
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const markCancelledCalls: unknown[][] = [];

  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/auth": {
      requirePermission: async () => opts.guard,
      writeAudit: async (_s: unknown, action: string, _t: string, detail: Record<string, unknown>) => {
        audits.push({ action, detail });
      },
    },
    "@/lib/ai-copilot/proposals": {
      getProposalById: async () => opts.proposal,
      markCancelled: async (...args: unknown[]) => {
        markCancelledCalls.push(args);
      },
    },
  };

  const url = new URL("./[proposalId]/cancel/route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const moduleObj = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`Unexpected require("${specifier}")`);
  };
  const context = vm.createContext({ module: moduleObj, exports: moduleObj.exports, require: requireShim, console, process, Promise, JSON, Error, URL });
  vm.runInContext(js, context);

  return { mod: moduleObj.exports as { POST: (req: Request, ctx: { params: Promise<{ proposalId: string }> }) => Promise<{ status: number; body: Record<string, unknown> }> }, audits, markCancelledCalls };
}

function ctx(proposalId = "prop-1") {
  return { params: Promise.resolve({ proposalId }) };
}

const ADMIN_GUARD: Guard = { ok: true, session: { id: "user-1", role: "ADMIN", username: "admin1" } };

test("proposal not found -> 404, nothing cancelled", async () => {
  const { mod, markCancelledCalls } = loadRoute({ guard: ADMIN_GUARD, proposal: null });
  const res = await mod.POST({} as Request, ctx());
  assert.equal(res.status, 404);
  assert.equal(markCancelledCalls.length, 0);
});

test("wrong user -> 403, nothing cancelled", async () => {
  const { mod, markCancelledCalls } = loadRoute({ guard: ADMIN_GUARD, proposal: { id: "prop-1", createdBy: "someone-else", status: "PENDING", action: "prepare_recruitment_request" } });
  const res = await mod.POST({} as Request, ctx());
  assert.equal(res.status, 403);
  assert.equal(markCancelledCalls.length, 0);
});

test("non-PENDING proposal -> 409, nothing cancelled", async () => {
  const { mod, markCancelledCalls } = loadRoute({ guard: ADMIN_GUARD, proposal: { id: "prop-1", createdBy: "user-1", status: "EXECUTED", action: "prepare_recruitment_request" } });
  const res = await mod.POST({} as Request, ctx());
  assert.equal(res.status, 409);
  assert.equal(markCancelledCalls.length, 0);
});

test("success: PENDING + correct user -> cancelled, AI_ACTION_CANCELLED audited", async () => {
  const { mod, audits, markCancelledCalls } = loadRoute({ guard: ADMIN_GUARD, proposal: { id: "prop-1", createdBy: "user-1", status: "PENDING", action: "prepare_recruitment_request" } });
  const res = await mod.POST({} as Request, ctx());
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(markCancelledCalls.length, 1);
  assert.deepEqual(audits.map((a) => a.action), ["AI_ACTION_CANCELLED"]);
});
