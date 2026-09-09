/**
 * AiAssistantPage — real render in jsdom (same render-tsx.ts harness already
 * established for workforce-requests/candidate-consent pages). Proves:
 *   - empty state shows the starter-question groups; clicking one sends it.
 *   - a successful reply renders the assistant bubble + tool source badges.
 *   - a 4xx/5xx from the API renders a structured ErrorState with retry —
 *     never an uncaught JSON parse error, matching the established
 *     fetchJsonWithTimeout/ErrorState contract used across the app.
 *   - "Xoá hội thoại" clears all messages.
 *   - an Action Proposal card renders Hủy/Xác nhận thực hiện, and clicking
 *     "Xác nhận thực hiện" calls the execute endpoint (never triggered by
 *     chat text) while "Hủy" calls the cancel endpoint — proving the UI
 *     never auto-executes from a chat reply alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

type FetchResponse = { status: number; jsonText: string | null };

async function renderPage(env: RenderEnv, respond: (url: string, body: unknown) => FetchResponse) {
  const requests: { url: string; body: unknown }[] = [];
  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body });
    const pick = respond(url, body);
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

  const mod = loadComponent(new URL("./page.tsx", import.meta.url), {
    stubs: { "@/components/ui": uiModule, "@/lib/api-client": apiClientModule },
  });
  const Page = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Page));
  });
  await act(async () => {
    await Promise.resolve();
  });

  return {
    container,
    requests,
    text: () => container.textContent ?? "",
    async click(matchText: string) {
      const el = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(matchText));
      if (!el) throw new Error(`No button found matching "${matchText}"`);
      await act(async () => {
        el.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

test("empty state shows the starter-question groups (TRA CỨU / PHÂN TÍCH / HÀNH ĐỘNG)", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, () => ({ status: 200, jsonText: "{}" }));
    for (const label of ["TRA CỨU", "PHÂN TÍCH", "HÀNH ĐỘNG"]) assert.match(ui.text(), new RegExp(label));
    for (const q of ["Hiện có bao nhiêu lao động đang làm việc?", "Ai chưa có mã vân tay (IT Code)?", "Bộ phận nào đang thiếu người nhiều nhất?", "Chuẩn bị một Yêu cầu tuyển dụng."]) {
      assert.match(ui.text(), new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    env.cleanup();
  }
});

test("clicking a starter question sends it and renders the assistant reply with tool source badges", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, () => ({
      status: 200,
      jsonText: JSON.stringify({
        reply: "Hiện có 128 lao động.",
        toolCallLog: [{ name: "get_current_headcount", ok: true }],
        proposals: [],
        meta: { finishReason: "stop", iterations: 2, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      }),
    }));
    await ui.click("Hiện có bao nhiêu lao động đang làm việc?");
    assert.match(ui.text(), /Hiện có 128 lao động\./);
    assert.match(ui.text(), /get_current_headcount/);
    assert.equal(ui.requests.length, 1);
    assert.equal((ui.requests[0].body as { question: string }).question, "Hiện có bao nhiêu lao động đang làm việc?");
  } finally {
    env.cleanup();
  }
});

test("a 502 from the API renders a structured ErrorState with retry, never an uncaught parse error", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, () => ({ status: 502, jsonText: JSON.stringify({ error: "Trợ lý AI không thể trả lời lúc này." }) }));
    await ui.click("Hiện có bao nhiêu lao động đang làm việc?");
    assert.match(ui.text(), /Không thể trả lời/);
    assert.match(ui.text(), /Trợ lý AI không thể trả lời lúc này\./);
    assert.match(ui.text(), /Thử lại/);
  } finally {
    env.cleanup();
  }
});

test("retry after a failure re-sends the same question", async () => {
  const env = installDom();
  try {
    let callCount = 0;
    const ui = await renderPage(env, () => {
      callCount += 1;
      if (callCount === 1) return { status: 502, jsonText: JSON.stringify({ error: "lỗi tạm thời" }) };
      return { status: 200, jsonText: JSON.stringify({ reply: "OK sau khi thử lại.", toolCallLog: [], proposals: [], meta: { finishReason: "stop", iterations: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }) };
    });
    await ui.click("Ai chưa có mã vân tay (IT Code)?");
    assert.match(ui.text(), /lỗi tạm thời/);
    await ui.click("Thử lại");
    assert.match(ui.text(), /OK sau khi thử lại\./);
    assert.equal(callCount, 2);
  } finally {
    env.cleanup();
  }
});

test("\"Xoá hội thoại\" clears all messages back to the starter-question empty state", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, () => ({
      status: 200,
      jsonText: JSON.stringify({ reply: "Trả lời.", toolCallLog: [], proposals: [], meta: { finishReason: "stop", iterations: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }),
    }));
    await ui.click("Bộ phận nào đang thiếu người nhiều nhất?");
    assert.match(ui.text(), /Trả lời\./);
    await ui.click("Xoá hội thoại");
    assert.doesNotMatch(ui.text(), /Trả lời\./);
    assert.match(ui.text(), /Đặt câu hỏi về nhân lực/);
  } finally {
    env.cleanup();
  }
});

const SAMPLE_PROPOSAL = { proposalId: "prop-1", action: "prepare_recruitment_request", humanReadablePreview: "ĐỀ XUẤT HÀNH ĐỘNG\n\nTạo Yêu cầu tuyển dụng\n\nBộ phận: Harvesting\nNam: 10\nNữ: 20", expiresAt: "2026-09-09T12:30:00.000Z" };

test("an action proposal renders as a card with Hủy/Xác nhận thực hiện — never auto-executed just because the chat reply arrived", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, () => ({
      status: 200,
      jsonText: JSON.stringify({ reply: "Đã chuẩn bị đề xuất, vui lòng xác nhận.", toolCallLog: [{ name: "prepare_recruitment_request", ok: true }], proposals: [SAMPLE_PROPOSAL], meta: { finishReason: "stop", iterations: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }),
    }));
    await ui.click("Chuẩn bị một Yêu cầu tuyển dụng.");
    assert.match(ui.text(), /Đề xuất hành động/i);
    assert.match(ui.text(), /Harvesting/);
    assert.match(ui.text(), /Hủy/);
    assert.match(ui.text(), /Xác nhận thực hiện/);
    // Only the ONE POST to /api/ai-copilot/chat happened — no execute call fired automatically.
    assert.equal(ui.requests.filter((r) => r.url.includes("/execute")).length, 0);
  } finally {
    env.cleanup();
  }
});

test("clicking \"Xác nhận thực hiện\" POSTs to the execute endpoint (proposalId in the URL, no payload) and shows success", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, (url) => {
      if (url.includes("/execute")) return { status: 200, jsonText: JSON.stringify({ resultRef: { requestId: "req-1", requestCode: "AI-20260909-ABCDEF" } }) };
      return { status: 200, jsonText: JSON.stringify({ reply: "Đã chuẩn bị đề xuất.", toolCallLog: [], proposals: [SAMPLE_PROPOSAL], meta: { finishReason: "stop", iterations: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }) };
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
    const ui = await renderPage(env, (url) => {
      if (url.includes("/cancel")) return { status: 200, jsonText: JSON.stringify({ ok: true }) };
      return { status: 200, jsonText: JSON.stringify({ reply: "Đã chuẩn bị đề xuất.", toolCallLog: [], proposals: [SAMPLE_PROPOSAL], meta: { finishReason: "stop", iterations: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }) };
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
