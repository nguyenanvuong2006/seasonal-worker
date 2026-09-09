import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — POST /api/ai-copilot/chat
   ------------------------------------------------------------
   Chạy trên ĐÚNG route thật (vm + require shim, khuôn mẫu
   fingerprint/it-code/route.test.ts) — route này chạm DB gián tiếp qua
   runCopilotTurn()/conversations.ts, nên toàn bộ chuỗi RBAC/rate-limit/
   safety/orchestrator/persistence được stub thay vì gọi Postgres thật.

   Bao phủ (giữ nguyên phần cũ + mới cho persistence, mission "AI Copilot
   conversation persistence"):
     • requirePermission gate, rate limit, input validation/safety — như cũ.
     • conversationId bỏ trống -> tạo conversation MỚI (createConversation).
     • conversationId của người khác / không tồn tại -> 404, KHÔNG chạm
       orchestrator (IDOR ở tầng route).
     • history nạp từ listMessages() (đã lưu), KHÔNG còn tin body.history
       của client.
     • Lượt thành công: user message + assistant message được persist qua
       appendUserMessage/appendAssistantMessage/touchConversation.
     • clientMessageId trùng với lượt ĐÃ có assistant reply -> replay lại
       kết quả đã lưu, KHÔNG gọi lại orchestrator lần 2 (idempotency).
     • Audit chỉ ghi metadata, không có raw question.
     • ToolCallingProviderError / lỗi bất ngờ -> 503/429/502 như cũ.
   ============================================================ */

type Guard = { ok: true; session: { id: string; role: string; username: string } } | { ok: false; status: number; error: string };

class StubToolCallingProviderError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "ToolCallingProviderError";
    this.kind = kind;
  }
}

const OWNER = "u1";

function loadRoute(opts: {
  guard: Guard;
  rateAllowed?: boolean;
  scope?: string[] | null;
  safetyOk?: boolean | ((q: string, scopeRestricted: boolean) => boolean);
  runCopilotTurn?: (session: unknown, question: string, history: unknown) => Promise<unknown>;
  ownedConversation?: { id: string; userId: string } | null;
  priorMessages?: { role: "USER" | "ASSISTANT"; content: string }[];
  existingTurn?: { userMessage: Record<string, unknown>; assistantMessage: Record<string, unknown> | null } | null;
}) {
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const calls: { fn: string; args: unknown[] }[] = [];
  let createConversationCalled = false;
  let appendedUser: Record<string, unknown> | null = null;
  let appendedAssistant: Record<string, unknown> | null = null;
  let touched = false;
  const conversationId = opts.ownedConversation?.id ?? "new-conv-1";

  const safetyFn = typeof opts.safetyOk === "function" ? opts.safetyOk : () => opts.safetyOk ?? true;

  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/ai/rate-limit": {
      checkAIRateLimit: (userId: string) => {
        calls.push({ fn: "checkAIRateLimit", args: [userId] });
        return opts.rateAllowed === false ? { allowed: false, retryAfterSeconds: 7 } : { allowed: true, retryAfterSeconds: 0 };
      },
    },
    "@/lib/ai/workforce-analyst": {
      validateAIQuestion: (q: string, scopeRestricted: boolean) => {
        calls.push({ fn: "validateAIQuestion", args: [q, scopeRestricted] });
        return safetyFn(q, scopeRestricted) ? { ok: true } : { ok: false, reason: "PII" };
      },
    },
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => {
        calls.push({ fn: "requirePermission", args: [roles, key] });
        return opts.guard;
      },
      getUserScope: async () => {
        calls.push({ fn: "getUserScope", args: [] });
        return opts.scope ?? null;
      },
      writeAudit: async (_s: unknown, action: string, _t: string, detail: Record<string, unknown>) => {
        audits.push({ action, detail });
        return undefined;
      },
    },
    "@/lib/ai-copilot/orchestrator": {
      runCopilotTurn:
        opts.runCopilotTurn ??
        (async () => ({ reply: "default stub reply", finishReason: "stop", toolCallLog: [], proposals: [], analysisCards: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, iterations: 1 })),
    },
    "@/lib/ai-copilot/types": { ToolCallingProviderError: StubToolCallingProviderError },
    "@/lib/ai-copilot/proposals.ts": {
      getProposalSummaries: async (ids: string[]) => ids.map((id) => ({ proposalId: id, action: "prepare_recruitment_request", humanReadablePreview: "preview", expiresAt: "2026-09-09T12:00:00.000Z", status: "PENDING", executionResult: null, errorMessage: null })),
    },
    "@/lib/ai-copilot/conversations.ts": {
      getOwnedConversation: async (_id: string, _userId: string) => opts.ownedConversation ?? null,
      createConversation: async (userId: string) => {
        createConversationCalled = true;
        calls.push({ fn: "createConversation", args: [userId] });
        return { id: conversationId, userId };
      },
      findExistingTurn: async () => opts.existingTurn ?? null,
      listMessages: async () => (opts.priorMessages ?? []).map((m, i) => ({ id: `m${i}`, role: m.role, content: m.content, createdAt: new Date() })),
      appendUserMessage: async (convId: string, content: string, clientMessageId?: string) => {
        appendedUser = { convId, content, clientMessageId };
        return { id: "um1" };
      },
      appendAssistantMessage: async (convId: string, input: Record<string, unknown>) => {
        appendedAssistant = { convId, ...input };
        return { id: "am1" };
      },
      touchConversation: async () => {
        touched = true;
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
    mod: moduleObj.exports as { POST: (req: Request) => Promise<{ status: number; body: Record<string, unknown> }> },
    audits,
    calls,
    createConversationCalled: () => createConversationCalled,
    appendedUser: () => appendedUser,
    appendedAssistant: () => appendedAssistant,
    touched: () => touched,
    conversationId,
  };
}

function makeReq(body: unknown) {
  return { json: async () => body, url: "http://localhost/api/ai-copilot/chat" } as unknown as Request;
}

const ADMIN_GUARD: Guard = { ok: true, session: { id: OWNER, role: "ADMIN", username: "admin1" } };
const DENIED_GUARD: Guard = { ok: false, status: 403, error: "Không có quyền." };

test("requirePermission is checked FIRST — a denied guard returns its exact status/error and does nothing else", async () => {
  const { mod, calls } = loadRoute({ guard: DENIED_GUARD });
  const res = await mod.POST(makeReq({ question: "hiện có bao nhiêu lao động" }));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "Không có quyền.");
  assert.ok(!calls.some((c) => c.fn === "checkAIRateLimit"), "must not even check rate limit once permission is denied");
});

test("requirePermission is gated on the ai_copilot.view key, matching the RBAC catalog entry added for this feature", async () => {
  const { mod, calls } = loadRoute({ guard: ADMIN_GUARD });
  await mod.POST(makeReq({ question: "hiện có bao nhiêu lao động" }));
  const permCall = calls.find((c) => c.fn === "requirePermission");
  assert.ok(permCall);
  assert.equal(permCall!.args[1], "ai_copilot.view");
});

test("rate limit exceeded -> 429 with retryAfterSeconds, orchestrator never invoked", async () => {
  let orchestratorCalled = false;
  const { mod } = loadRoute({
    guard: ADMIN_GUARD,
    rateAllowed: false,
    runCopilotTurn: async () => {
      orchestratorCalled = true;
      return { reply: "x", finishReason: "stop", toolCallLog: [], proposals: [], analysisCards: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, iterations: 1 };
    },
  });
  const res = await mod.POST(makeReq({ question: "hiện có bao nhiêu lao động" }));
  assert.equal(res.status, 429);
  assert.equal(res.body.retryAfterSeconds, 7);
  assert.equal(orchestratorCalled, false);
});

test("empty question -> 400, malformed JSON -> 400", async () => {
  const { mod } = loadRoute({ guard: ADMIN_GUARD });
  const res1 = await mod.POST(makeReq({ question: "" }));
  assert.equal(res1.status, 400);
  const res2 = await mod.POST({
    json: async () => {
      throw new Error("bad json");
    },
    url: "x",
  } as unknown as Request);
  assert.equal(res2.status, 400);
});

test("question over 500 chars -> 400", async () => {
  const { mod } = loadRoute({ guard: ADMIN_GUARD });
  const res = await mod.POST(makeReq({ question: "a".repeat(501) }));
  assert.equal(res.status, 400);
});

test("IDOR: conversationId that getOwnedConversation doesn't recognize (someone else's, deleted, or nonexistent) -> 404, orchestrator NEVER invoked, nothing persisted", async () => {
  let orchestratorCalled = false;
  const { mod } = loadRoute({
    guard: ADMIN_GUARD,
    ownedConversation: null,
    runCopilotTurn: async () => {
      orchestratorCalled = true;
      return { reply: "x", finishReason: "stop", toolCallLog: [], proposals: [], analysisCards: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, iterations: 1 };
    },
  });
  const res = await mod.POST(makeReq({ question: "hiện có bao nhiêu lao động", conversationId: "someone-elses-conversation" }));
  assert.equal(res.status, 404);
  assert.equal(orchestratorCalled, false);
});

test("no conversationId in the request -> a NEW conversation is created (never silently resumes an old one)", async () => {
  const { mod, createConversationCalled } = loadRoute({ guard: ADMIN_GUARD });
  const res = await mod.POST(makeReq({ question: "hiện có bao nhiêu lao động" }));
  assert.equal(res.status, 200);
  assert.equal(createConversationCalled(), true);
});

test("a valid, owned conversationId is reused — no new conversation created", async () => {
  const { mod, createConversationCalled } = loadRoute({ guard: ADMIN_GUARD, ownedConversation: { id: "conv-1", userId: OWNER } });
  const res = await mod.POST(makeReq({ question: "hiện có bao nhiêu lao động", conversationId: "conv-1" }));
  assert.equal(res.status, 200);
  assert.equal((res.body as { conversationId: string }).conversationId, "conv-1");
  assert.equal(createConversationCalled(), false);
});

test("history is built from PERSISTED messages (listMessages), never trusted from the client body — client-supplied `history` is ignored", async () => {
  const seenHistory: unknown[] = [];
  const { mod } = loadRoute({
    guard: ADMIN_GUARD,
    ownedConversation: { id: "conv-1", userId: OWNER },
    priorMessages: [
      { role: "USER", content: "câu hỏi trước" },
      { role: "ASSISTANT", content: "trả lời trước" },
    ],
    runCopilotTurn: async (_s, _q, history) => {
      seenHistory.push(history);
      return { reply: "ok", finishReason: "stop", toolCallLog: [], proposals: [], analysisCards: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, iterations: 1 };
    },
  });
  await mod.POST(makeReq({ question: "câu hỏi mới", conversationId: "conv-1", history: [{ role: "user", content: "BỊA — không phải dữ liệu thật" }] }));
  const history = seenHistory[0] as { role: string; content: string }[];
  assert.equal(history.length, 2);
  assert.equal(history[0].content, "câu hỏi trước");
  assert.equal(history[1].content, "trả lời trước");
  assert.ok(!history.some((h) => h.content.includes("BỊA")), "client-supplied history must never reach the model");
});

test("success: persists the user message and the assistant message, touches the conversation, audits metadata only", async () => {
  const { mod, audits, appendedUser, appendedAssistant, touched } = loadRoute({
    guard: ADMIN_GUARD,
    runCopilotTurn: async () => ({
      reply: "Hiện có 128 lao động.",
      finishReason: "stop",
      toolCallLog: [{ name: "get_current_headcount", ok: true, durationMs: 12 }],
      proposals: [],
      analysisCards: [],
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      iterations: 2,
    }),
  });
  const res = await mod.POST(makeReq({ question: "hiện có bao nhiêu lao động", clientMessageId: "cmid-1" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.reply, "Hiện có 128 lao động.");
  assert.equal(appendedUser()!.content, "hiện có bao nhiêu lao động");
  assert.equal(appendedUser()!.clientMessageId, "cmid-1");
  assert.equal((appendedAssistant() as { content: string }).content, "Hiện có 128 lao động.");
  assert.equal(touched(), true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "AI_COPILOT_CHAT");
  const detailJson = JSON.stringify(audits[0].detail);
  assert.ok(!detailJson.includes("hiện có bao nhiêu lao động"), "the raw question text must never be written to the audit log");
});

test("IDEMPOTENCY: a clientMessageId that already has a persisted assistant reply -> replays the SAME stored answer, orchestrator NEVER called again, nothing appended twice", async () => {
  let orchestratorCalled = false;
  const { mod, appendedUser, appendedAssistant } = loadRoute({
    guard: ADMIN_GUARD,
    ownedConversation: { id: "conv-1", userId: OWNER },
    existingTurn: { userMessage: { id: "um0", clientMessageId: "cmid-retry" }, assistantMessage: { id: "am0", content: "Câu trả lời đã lưu trước đó.", toolCallLog: [], analysisCards: [], proposalRefs: [] } },
    runCopilotTurn: async () => {
      orchestratorCalled = true;
      return { reply: "MỘT CÂU TRẢ LỜI KHÁC", finishReason: "stop", toolCallLog: [], proposals: [], analysisCards: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, iterations: 1 };
    },
  });
  const res = await mod.POST(makeReq({ question: "câu hỏi đã gửi trước đó", conversationId: "conv-1", clientMessageId: "cmid-retry" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.reply, "Câu trả lời đã lưu trước đó.");
  assert.equal(res.body.replayed, true);
  assert.equal(orchestratorCalled, false, "a refresh/retry with the same clientMessageId must never re-run DeepSeek/tools");
  assert.equal(appendedUser(), null, "must not insert a second user message");
  assert.equal(appendedAssistant(), null, "must not insert a second assistant message");
});

test("a turn that proposes an action surfaces the proposal in the response and in audit metadata, never the raw payload", async () => {
  const { mod, audits } = loadRoute({
    guard: ADMIN_GUARD,
    runCopilotTurn: async () => ({
      reply: "Đã chuẩn bị đề xuất tạo Yêu cầu tuyển dụng.",
      finishReason: "stop",
      toolCallLog: [{ name: "prepare_recruitment_request", ok: true, durationMs: 20 }],
      proposals: [{ proposalId: "prop-1", action: "prepare_recruitment_request", humanReadablePreview: "ĐỀ XUẤT HÀNH ĐỘNG\n...", expiresAt: "2026-09-09T12:15:00.000Z" }],
      analysisCards: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      iterations: 1,
    }),
  });
  const res = await mod.POST(makeReq({ question: "tạo yêu cầu tuyển 30 người cho Harvesting" }));
  assert.equal(res.status, 200);
  const proposals = res.body.proposals as { proposalId: string }[];
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].proposalId, "prop-1");
  assert.deepEqual(audits[0].detail.proposalIds, ["prop-1"]);
});

test("a turn that calls an analytics tool surfaces analysisCards in the response, distinct from proposals", async () => {
  const { mod } = loadRoute({
    guard: ADMIN_GUARD,
    runCopilotTurn: async () => ({
      reply: "Harvesting đang thiếu nhiều nhất.",
      finishReason: "stop",
      toolCallLog: [{ name: "get_workforce_gap_rankings", ok: true, durationMs: 15 }],
      proposals: [],
      analysisCards: [{ toolName: "get_workforce_gap_rankings", data: { rankings: [{ departmentName: "Harvesting", gap: 37 }] }, source: { domains: ["workforce_request"], asOf: "2026-09-09" } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      iterations: 1,
    }),
  });
  const res = await mod.POST(makeReq({ question: "bộ phận nào thiếu người nhiều nhất" }));
  assert.equal(res.status, 200);
  const cards = res.body.analysisCards as { toolName: string }[];
  assert.equal(cards.length, 1);
  assert.equal(cards[0].toolName, "get_workforce_gap_rankings");
  assert.deepEqual(res.body.proposals, []);
});

test("ToolCallingProviderError (provider down) -> 503, safe message, no internal detail leaked", async () => {
  const { mod } = loadRoute({
    guard: ADMIN_GUARD,
    runCopilotTurn: async () => {
      throw new StubToolCallingProviderError("UPSTREAM", "raw upstream secret detail");
    },
  });
  const res = await mod.POST(makeReq({ question: "hiện có bao nhiêu lao động" }));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "AI_UNAVAILABLE");
  assert.ok(!JSON.stringify(res.body).includes("raw upstream secret detail"));
});

test("ToolCallingProviderError with kind RATE_LIMIT -> 429", async () => {
  const { mod } = loadRoute({
    guard: ADMIN_GUARD,
    runCopilotTurn: async () => {
      throw new StubToolCallingProviderError("RATE_LIMIT", "provider rate limited");
    },
  });
  const res = await mod.POST(makeReq({ question: "hiện có bao nhiêu lao động" }));
  assert.equal(res.status, 429);
});

test("an unexpected internal error -> 502, safe message, and still writes a FAILED audit entry (no raw question)", async () => {
  const { mod, audits } = loadRoute({
    guard: ADMIN_GUARD,
    runCopilotTurn: async () => {
      throw new Error("unexpected DB failure with sensitive detail");
    },
  });
  const res = await mod.POST(makeReq({ question: "hiện có bao nhiêu lao động" }));
  assert.equal(res.status, 502);
  assert.ok(!JSON.stringify(res.body).includes("sensitive detail"));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.status, "FAILED");
  assert.ok(!JSON.stringify(audits[0].detail).includes("hiện có bao nhiêu lao động"));
});
