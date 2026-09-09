/**
 * AiAssistantClient — real render in jsdom (same render-tsx.ts harness
 * already established for workforce-requests/candidate-consent pages).
 * page.tsx itself is now an async Server Component (session/redirect
 * only — see document-merge/page.tsx's same convention) and is not
 * rendered here; this file renders the actual client component the
 * server page mounts, ai-assistant-client.tsx.
 *
 * Proves (conversation persistence mission):
 *   - on mount, GET /api/ai-copilot/conversations restores the most
 *     recent conversation (never starts from React state alone).
 *   - a 403 from that initial call renders a permission-denied state,
 *     not a functional-looking chat (Defect 2's "direct page must not
 *     provide functional AI access").
 *   - sending a message includes conversationId + a fresh clientMessageId
 *     in the POST body.
 *   - "Cuộc trò chuyện mới" clears the visible chat WITHOUT calling
 *     DELETE — it is NOT the same action as deleting a conversation.
 *   - the conversation history panel lists past conversations and
 *     switching loads their messages via GET .../conversations/[id].
 *   - deleting a conversation from history requires confirm() and calls
 *     DELETE .../conversations/[id].
 *   - an Action Proposal card still renders Hủy/Xác nhận thực hiện, and
 *     confirming/cancelling never auto-executes from chat text alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

type FetchResponse = { status: number; jsonText: string | null };

function fakeSearchParams(initial = "") {
  const params = new URLSearchParams(initial);
  return { get: (key: string) => params.get(key), toString: () => params.toString() };
}

function nextNavigationStub(opts?: { search?: string; onReplace?: (url: string) => void }) {
  return {
    useRouter: () => ({ replace: (url: string) => opts?.onReplace?.(url), push: () => {} }),
    usePathname: () => "/admin/ai-assistant",
    useSearchParams: () => fakeSearchParams(opts?.search ?? ""),
  };
}

async function renderClient(env: RenderEnv, respond: (method: string, url: string, body: unknown) => FetchResponse, navOpts?: Parameters<typeof nextNavigationStub>[0]) {
  const requests: { method: string; url: string; body: unknown }[] = [];
  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url, body });
    const pick = respond(method, url, body);
    return {
      ok: pick.status >= 200 && pick.status < 300,
      status: pick.status,
      headers: new Headers(),
      text: async () => pick.jsonText ?? "",
    } as unknown as Response;
  };

  const uiModule = loadComponent(new URL("../../../../components/ui.tsx", import.meta.url));
  const apiClientModule = loadComponent(new URL("../../../../lib/api-client.ts", import.meta.url));

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./ai-assistant-client.tsx", import.meta.url), {
    stubs: { "@/components/ui": uiModule, "@/lib/api-client": apiClientModule, "next/navigation": nextNavigationStub(navOpts) },
  });
  const Client = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Client));
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }

  return {
    container,
    requests,
    text: () => container.textContent ?? "",
    async click(matchText: string) {
      const el = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(matchText));
      if (!el) throw new Error(`No button found matching "${matchText}"`);
      await act(async () => {
        el.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
    },
  };
}

function chatSuccess(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: "conv-auto",
    reply: "Hiện có 128 lao động.",
    toolCallLog: [{ name: "get_current_headcount", ok: true }],
    proposals: [],
    analysisCards: [],
    meta: { finishReason: "stop", iterations: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ...overrides,
  };
}

test("on mount, restores the most recent conversation (GET conversations, then GET its messages) and shows them instead of the empty starter state", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, (method, url) => {
      if (method === "GET" && url.endsWith("/api/ai-copilot/conversations")) {
        return { status: 200, jsonText: JSON.stringify({ conversations: [{ id: "conv-1", title: "Kiểm tra nhân lực", createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", lastMessageAt: "2026-09-09T00:00:00Z" }] }) };
      }
      if (method === "GET" && url.includes("/api/ai-copilot/conversations/conv-1")) {
        return {
          status: 200,
          jsonText: JSON.stringify({
            conversation: { id: "conv-1", title: "Kiểm tra nhân lực" },
            messages: [{ id: "m1", role: "USER", content: "hiện có bao nhiêu lao động", toolCallLog: [], analysisCards: [], proposals: [], createdAt: "2026-09-09T00:00:00Z" }],
          }),
        };
      }
      return { status: 200, jsonText: "{}" };
    });
    assert.match(ui.text(), /hiện có bao nhiêu lao động/);
    assert.ok(ui.requests.some((r) => r.method === "GET" && r.url.includes("/conversations/conv-1")));
  } finally {
    env.cleanup();
  }
});

test("a 403 on the initial conversations fetch renders a permission-denied state, not a functional chat (Defect 2)", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, () => ({ status: 403, jsonText: JSON.stringify({ error: "Bạn không có quyền truy cập dữ liệu này." }) }));
    assert.match(ui.text(), /không có quyền sử dụng Trợ lý AI/);
    assert.doesNotMatch(ui.text(), /Nhập câu hỏi/);
  } finally {
    env.cleanup();
  }
});

test("empty state (no prior conversations) shows the starter-question groups", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, (method, url) => {
      if (url.endsWith("/api/ai-copilot/conversations")) return { status: 200, jsonText: JSON.stringify({ conversations: [] }) };
      return { status: 200, jsonText: "{}" };
    });
    for (const label of ["TRA CỨU", "PHÂN TÍCH", "HÀNH ĐỘNG"]) assert.match(ui.text(), new RegExp(label));
  } finally {
    env.cleanup();
  }
});

test("sending a message includes conversationId (null on a brand-new chat) and a fresh clientMessageId", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, (method, url) => {
      if (url.endsWith("/api/ai-copilot/conversations")) return { status: 200, jsonText: JSON.stringify({ conversations: [] }) };
      if (method === "POST" && url.endsWith("/api/ai-copilot/chat")) return { status: 200, jsonText: JSON.stringify(chatSuccess()) };
      return { status: 200, jsonText: "{}" };
    });
    await ui.click("Hiện có bao nhiêu lao động đang làm việc?");
    const chatReq = ui.requests.find((r) => r.url.endsWith("/api/ai-copilot/chat"));
    assert.ok(chatReq);
    const body = chatReq!.body as { question: string; conversationId: string | null; clientMessageId: string };
    assert.equal(body.question, "Hiện có bao nhiêu lao động đang làm việc?");
    assert.equal(body.conversationId, null);
    assert.ok(typeof body.clientMessageId === "string" && body.clientMessageId.length > 0);
    assert.match(ui.text(), /Hiện có 128 lao động\./);
  } finally {
    env.cleanup();
  }
});

test("'Cuộc trò chuyện mới' clears the visible chat WITHOUT calling DELETE — distinct from deleting a conversation", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, (method, url) => {
      if (url.endsWith("/api/ai-copilot/conversations")) return { status: 200, jsonText: JSON.stringify({ conversations: [] }) };
      if (method === "POST" && url.endsWith("/api/ai-copilot/chat")) return { status: 200, jsonText: JSON.stringify(chatSuccess()) };
      return { status: 200, jsonText: "{}" };
    });
    await ui.click("Bộ phận nào đang thiếu người nhiều nhất?");
    assert.match(ui.text(), /Hiện có 128 lao động\./);
    await ui.click("Cuộc trò chuyện mới");
    assert.doesNotMatch(ui.text(), /Hiện có 128 lao động\./);
    assert.match(ui.text(), /Đặt câu hỏi về nhân lực/);
    assert.equal(ui.requests.filter((r) => r.method === "DELETE").length, 0, "starting a new conversation must never delete anything server-side");
  } finally {
    env.cleanup();
  }
});

test("history panel lists past conversations grouped by day, and selecting one loads its messages", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, (method, url) => {
      if (method === "GET" && url.endsWith("/api/ai-copilot/conversations")) {
        return {
          status: 200,
          jsonText: JSON.stringify({
            conversations: [
              { id: "conv-today", title: "Kiểm tra nhân lực hiện tại", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() },
              { id: "conv-old", title: "So sánh nhu cầu 2025/2026", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z", lastMessageAt: "2020-01-01T00:00:00Z" },
            ],
          }),
        };
      }
      if (method === "GET" && url.includes("/conversations/conv-today")) return { status: 200, jsonText: JSON.stringify({ conversation: { id: "conv-today", title: "x" }, messages: [] }) };
      if (method === "GET" && url.includes("/conversations/conv-old")) return { status: 200, jsonText: JSON.stringify({ conversation: { id: "conv-old", title: "x" }, messages: [{ id: "m1", role: "USER", content: "câu hỏi cũ", toolCallLog: [], analysisCards: [], proposals: [], createdAt: "2020-01-01T00:00:00Z" }] }) };
      return { status: 200, jsonText: "{}" };
    });
    await ui.click("Lịch sử");
    assert.match(ui.text(), /Hôm nay/);
    assert.match(ui.text(), /Trước đó/);
    assert.match(ui.text(), /So sánh nhu cầu 2025\/2026/);
    await ui.click("So sánh nhu cầu 2025/2026");
    assert.match(ui.text(), /câu hỏi cũ/);
  } finally {
    env.cleanup();
  }
});

test("deleting a conversation from history requires confirm() and calls DELETE on the right id", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, (method, url) => {
      if (method === "GET" && url.endsWith("/api/ai-copilot/conversations")) {
        return { status: 200, jsonText: JSON.stringify({ conversations: [{ id: "conv-1", title: "Xoá tôi đi", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() }] }) };
      }
      if (method === "GET" && url.includes("/conversations/conv-1")) return { status: 200, jsonText: JSON.stringify({ conversation: { id: "conv-1", title: "x" }, messages: [] }) };
      if (method === "DELETE") return { status: 200, jsonText: JSON.stringify({ ok: true }) };
      return { status: 200, jsonText: "{}" };
    });
    await ui.click("Lịch sử");
    const trashButtons = Array.from(ui.container.querySelectorAll('button[aria-label="Xoá cuộc trò chuyện"]'));
    assert.equal(trashButtons.length, 1);
    await (async () => {
      const { act } = await import("react");
      await act(async () => {
        trashButtons[0].dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
    })();
    assert.equal(env.confirms.length, 1, "deleting a conversation must require an explicit confirm — never a silent side effect of a new-chat click");
    const deleteReq = ui.requests.find((r) => r.method === "DELETE");
    assert.ok(deleteReq);
    assert.match(deleteReq!.url, /\/conversations\/conv-1$/);
  } finally {
    env.cleanup();
  }
});

const SAMPLE_PROPOSAL = { proposalId: "prop-1", action: "prepare_recruitment_request", humanReadablePreview: "ĐỀ XUẤT HÀNH ĐỘNG\n\nTạo Yêu cầu tuyển dụng\n\nBộ phận: Harvesting\nNam: 10\nNữ: 20", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };

test("an action proposal renders as a card with Hủy/Xác nhận thực hiện — never auto-executed just because the chat reply arrived", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, (method, url) => {
      if (url.endsWith("/api/ai-copilot/conversations")) return { status: 200, jsonText: JSON.stringify({ conversations: [] }) };
      if (method === "POST" && url.endsWith("/api/ai-copilot/chat")) return { status: 200, jsonText: JSON.stringify(chatSuccess({ reply: "Đã chuẩn bị đề xuất, vui lòng xác nhận.", toolCallLog: [{ name: "prepare_recruitment_request", ok: true }], proposals: [SAMPLE_PROPOSAL] })) };
      return { status: 200, jsonText: "{}" };
    });
    await ui.click("Chuẩn bị một Yêu cầu tuyển dụng.");
    assert.match(ui.text(), /Đề xuất hành động/i);
    assert.match(ui.text(), /Harvesting/);
    assert.match(ui.text(), /Hủy/);
    assert.match(ui.text(), /Xác nhận thực hiện/);
    assert.equal(ui.requests.filter((r) => r.url.includes("/execute")).length, 0);
  } finally {
    env.cleanup();
  }
});

test("clicking \"Xác nhận thực hiện\" POSTs to the execute endpoint (proposalId in the URL, no payload) and shows success", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, (method, url) => {
      if (url.endsWith("/api/ai-copilot/conversations")) return { status: 200, jsonText: JSON.stringify({ conversations: [] }) };
      if (url.includes("/execute")) return { status: 200, jsonText: JSON.stringify({ resultRef: { requestId: "req-1", requestCode: "AI-20260909-ABCDEF" } }) };
      if (method === "POST" && url.endsWith("/api/ai-copilot/chat")) return { status: 200, jsonText: JSON.stringify(chatSuccess({ reply: "Đã chuẩn bị đề xuất.", proposals: [SAMPLE_PROPOSAL] })) };
      return { status: 200, jsonText: "{}" };
    });
    await ui.click("Chuẩn bị một Yêu cầu tuyển dụng.");
    await ui.click("Xác nhận thực hiện");
    const executeReq = ui.requests.find((r) => r.url.includes("/execute"));
    assert.ok(executeReq, "must call the execute endpoint");
    assert.match(executeReq!.url, /\/api\/ai-copilot\/action\/prop-1\/execute/);
    assert.equal(executeReq!.body, null, "execute must never send a payload — only the proposalId is in the URL");
    assert.match(ui.text(), /Đã thực hiện thành công/);
  } finally {
    env.cleanup();
  }
});

test("clicking \"Hủy\" POSTs to the cancel endpoint and shows cancelled, never calling execute", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, (method, url) => {
      if (url.endsWith("/api/ai-copilot/conversations")) return { status: 200, jsonText: JSON.stringify({ conversations: [] }) };
      if (url.includes("/cancel")) return { status: 200, jsonText: JSON.stringify({ ok: true }) };
      if (method === "POST" && url.endsWith("/api/ai-copilot/chat")) return { status: 200, jsonText: JSON.stringify(chatSuccess({ reply: "Đã chuẩn bị đề xuất.", proposals: [SAMPLE_PROPOSAL] })) };
      return { status: 200, jsonText: "{}" };
    });
    await ui.click("Chuẩn bị một Yêu cầu tuyển dụng.");
    await ui.click("Hủy");
    const cancelReq = ui.requests.find((r) => r.url.includes("/cancel"));
    assert.ok(cancelReq);
    assert.match(ui.text(), /Đã hủy đề xuất/);
    assert.equal(ui.requests.filter((r) => r.url.includes("/execute")).length, 0);
  } finally {
    env.cleanup();
  }
});

test("an analysis-tool result renders as an Analysis Card with a ranking list and the source/asOf footer", async () => {
  const env = installDom();
  try {
    const ui = await renderClient(env, (method, url) => {
      if (url.endsWith("/api/ai-copilot/conversations")) return { status: 200, jsonText: JSON.stringify({ conversations: [] }) };
      if (method === "POST" && url.endsWith("/api/ai-copilot/chat")) {
        return {
          status: 200,
          jsonText: JSON.stringify(
            chatSuccess({
              reply: "Harvesting đang thiếu nhiều nhất.",
              toolCallLog: [{ name: "get_workforce_gap_rankings", ok: true }],
              analysisCards: [{ toolName: "get_workforce_gap_rankings", data: { rankings: [{ departmentId: "d1", departmentName: "Harvesting", requested: 145, current: 108, gap: 37 }], asOfDate: "2026-09-09" }, source: { domains: ["workforce_request"], asOf: "2026-09-09" } }],
            }),
          ),
        };
      }
      return { status: 200, jsonText: "{}" };
    });
    await ui.click("Bộ phận nào đang thiếu người nhiều nhất?");
    assert.match(ui.text(), /Xếp hạng khoảng trống nhân lực/);
    assert.match(ui.text(), /Harvesting/);
    assert.match(ui.text(), /37/);
    assert.match(ui.text(), /Dữ liệu đến: 2026-09-09/);
  } finally {
    env.cleanup();
  }
});
