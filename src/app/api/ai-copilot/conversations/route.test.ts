import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET/POST /api/ai-copilot/conversations
   ============================================================ */

type Guard = { ok: true; session: { id: string; role: string; username: string } } | { ok: false; status: number; error: string };

function loadRoute(opts: { guard: Guard; conversations?: { id: string; title: string | null; createdAt: Date; updatedAt: Date; lastMessageAt: Date }[]; created?: { id: string; title: string | null; createdAt: Date } }) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => {
        calls.push({ fn: "requirePermission", args: [roles, key] });
        return opts.guard;
      },
    },
    "@/lib/ai-copilot/conversations.ts": {
      listConversations: async (userId: string) => {
        calls.push({ fn: "listConversations", args: [userId] });
        return opts.conversations ?? [];
      },
      createConversation: async (userId: string) => {
        calls.push({ fn: "createConversation", args: [userId] });
        return opts.created ?? { id: "new-conv", title: null, createdAt: new Date() };
      },
    },
  };

  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const moduleObj = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`Unexpected require("${specifier}")`);
  };
  const context = vm.createContext({ module: moduleObj, exports: moduleObj.exports, require: requireShim, console, Date, Promise, JSON, Object, Array, Error, URL });
  vm.runInContext(js, context);

  return { mod: moduleObj.exports as { GET: () => Promise<{ status: number; body: Record<string, unknown> }>; POST: () => Promise<{ status: number; body: Record<string, unknown> }> }, calls };
}

const OWNER_GUARD: Guard = { ok: true, session: { id: "user-1", role: "HR_RECRUITER", username: "recruiter1" } };
const DENIED_GUARD: Guard = { ok: false, status: 403, error: "Không có quyền." };

test("GET: denied guard (no ai_copilot.view) -> exact status/error, never lists conversations", async () => {
  const { mod, calls } = loadRoute({ guard: DENIED_GUARD });
  const res = await mod.GET();
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "Không có quyền.");
  assert.ok(!calls.some((c) => c.fn === "listConversations"));
});

test("GET: requirePermission is gated on ai_copilot.view", async () => {
  const { calls, mod } = loadRoute({ guard: OWNER_GUARD });
  await mod.GET();
  const permCall = calls.find((c) => c.fn === "requirePermission");
  assert.equal(permCall!.args[1], "ai_copilot.view");
});

test("GET: lists conversations scoped to the AUTHENTICATED session id — never a client-supplied userId", async () => {
  const { mod, calls } = loadRoute({
    guard: OWNER_GUARD,
    conversations: [{ id: "c1", title: "Kiểm tra nhân lực", createdAt: new Date(), updatedAt: new Date(), lastMessageAt: new Date() }],
  });
  const res = await mod.GET();
  assert.equal(res.status, 200);
  const conversations = res.body.conversations as { id: string }[];
  assert.equal(conversations.length, 1);
  const listCall = calls.find((c) => c.fn === "listConversations");
  assert.equal(listCall!.args[0], "user-1");
});

test("POST: denied guard -> never creates a conversation", async () => {
  const { mod, calls } = loadRoute({ guard: DENIED_GUARD });
  const res = await mod.POST();
  assert.equal(res.status, 403);
  assert.ok(!calls.some((c) => c.fn === "createConversation"));
});

test("POST: creates a new conversation for the authenticated session id ('Cuộc trò chuyện mới')", async () => {
  const { mod, calls } = loadRoute({ guard: OWNER_GUARD, created: { id: "conv-new", title: null, createdAt: new Date() } });
  const res = await mod.POST();
  assert.equal(res.status, 201);
  assert.equal((res.body as { id: string }).id, "conv-new");
  const createCall = calls.find((c) => c.fn === "createConversation");
  assert.equal(createCall!.args[0], "user-1");
});
