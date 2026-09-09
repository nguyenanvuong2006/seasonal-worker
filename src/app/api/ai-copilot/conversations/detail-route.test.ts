import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET/DELETE /api/ai-copilot/conversations/[id]
   ------------------------------------------------------------
   File đặt CẠNH thư mục [id]/ (không đặt bên trong) — node --test's glob
   silently bỏ qua *.test.ts nằm trong thư mục có dấu ngoặc vuông (lỗi đã
   gặp nhiều lần trong session này với [proposalId]/). Import route bằng
   đường dẫn tương đối tới ./[id]/route.ts — URL/import đều xử lý ký tự
   ngoặc vuông đúng, chỉ có glob CLI của node --test là có lỗi này.

   Bao phủ IDOR: một conversationId hợp lệ nhưng KHÔNG thuộc về session
   hiện tại phải trả về 404 giống hệt "không tồn tại" — không có 403 khác
   biệt (tránh lộ thông tin tồn tại), và writeAudit/softDelete không bao
   giờ được gọi cho user không sở hữu.
   ============================================================ */

type Guard = { ok: true; session: { id: string; role: string; username: string } } | { ok: false; status: number; error: string };

function loadRoute(opts: {
  guard: Guard;
  ownedConversation?: { id: string; title: string | null; createdAt: Date } | null;
  messages?: { id: string; role: "USER" | "ASSISTANT"; content: string; toolCallLog: unknown[]; analysisCards: unknown[]; proposalRefs: string[]; createdAt: Date }[];
  deleteSucceeds?: boolean;
}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => {
        calls.push({ fn: "requirePermission", args: [roles, key] });
        return opts.guard;
      },
      writeAudit: async (_s: unknown, action: string, _t: string, detail: Record<string, unknown>) => {
        audits.push({ action, detail });
      },
    },
    "@/lib/ai-copilot/conversations.ts": {
      getOwnedConversation: async (id: string, userId: string) => {
        calls.push({ fn: "getOwnedConversation", args: [id, userId] });
        return opts.ownedConversation ?? null;
      },
      listMessages: async (id: string, userId: string) => {
        calls.push({ fn: "listMessages", args: [id, userId] });
        return opts.messages ?? [];
      },
      softDeleteConversation: async (id: string, userId: string) => {
        calls.push({ fn: "softDeleteConversation", args: [id, userId] });
        return opts.deleteSucceeds ?? true;
      },
    },
    "@/lib/ai-copilot/proposals.ts": { getProposalSummaries: async () => [] },
  };

  const url = new URL("./[id]/route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const moduleObj = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`Unexpected require("${specifier}")`);
  };
  const context = vm.createContext({ module: moduleObj, exports: moduleObj.exports, require: requireShim, console, Date, Promise, JSON, Object, Array, Error, URL });
  vm.runInContext(js, context);

  return {
    mod: moduleObj.exports as {
      GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
      DELETE: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
    },
    calls,
    audits,
  };
}

function makeReq() {
  return {} as Request;
}
function ctx(id = "conv-1") {
  return { params: Promise.resolve({ id }) };
}

const OWNER_GUARD: Guard = { ok: true, session: { id: "user-1", role: "HR_RECRUITER", username: "recruiter1" } };
const OTHER_USER_GUARD: Guard = { ok: true, session: { id: "user-2", role: "ADMIN", username: "admin-someone-else" } };
const DENIED_GUARD: Guard = { ok: false, status: 403, error: "Không có quyền." };

test("GET: denied guard -> exact status/error, never touches conversations", async () => {
  const { mod, calls } = loadRoute({ guard: DENIED_GUARD });
  const res = await mod.GET(makeReq(), ctx());
  assert.equal(res.status, 403);
  assert.ok(!calls.some((c) => c.fn === "getOwnedConversation"));
});

test("GET: owner reading their own conversation -> 200 with messages", async () => {
  const { mod } = loadRoute({
    guard: OWNER_GUARD,
    ownedConversation: { id: "conv-1", title: "Kiểm tra nhân lực", createdAt: new Date() },
    messages: [{ id: "m1", role: "USER", content: "hi", toolCallLog: [], analysisCards: [], proposalRefs: [], createdAt: new Date() }],
  });
  const res = await mod.GET(makeReq(), ctx());
  assert.equal(res.status, 200);
  const messages = res.body.messages as { content: string }[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "hi");
});

test("IDOR: GET on a conversationId not owned by the caller (getOwnedConversation returns null, e.g. it belongs to ADMIN's own colleague) -> 404, same as truly nonexistent — never distinguished, never leaks another user's messages", async () => {
  const { mod, calls } = loadRoute({ guard: OTHER_USER_GUARD, ownedConversation: null });
  const res = await mod.GET(makeReq(), ctx("someone-elses-conversation"));
  assert.equal(res.status, 404);
  assert.ok(!calls.some((c) => c.fn === "listMessages"), "must never fetch messages once ownership check fails — even for an ADMIN session");
});

test("DELETE: denied guard -> never soft-deletes", async () => {
  const { mod, calls } = loadRoute({ guard: DENIED_GUARD });
  const res = await mod.DELETE(makeReq(), ctx());
  assert.equal(res.status, 403);
  assert.ok(!calls.some((c) => c.fn === "softDeleteConversation"));
});

test("DELETE: owner deleting their own conversation -> 200, audited", async () => {
  const { mod, audits } = loadRoute({ guard: OWNER_GUARD, deleteSucceeds: true });
  const res = await mod.DELETE(makeReq(), ctx());
  assert.equal(res.status, 200);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "AI_CONVERSATION_DELETED");
});

test("IDOR: DELETE on a conversation not owned by the caller -> 404 (softDeleteConversation's own WHERE excludes it), no audit written", async () => {
  const { mod, audits } = loadRoute({ guard: OTHER_USER_GUARD, deleteSucceeds: false });
  const res = await mod.DELETE(makeReq(), ctx("someone-elses-conversation"));
  assert.equal(res.status, 404);
  assert.equal(audits.length, 0, "a failed/unauthorized delete must never be audited as if it happened");
});
