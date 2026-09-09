/**
 * AiAssistantPage — real render in jsdom (same render-tsx.ts harness already
 * established for workforce-requests/candidate-consent pages). Proves:
 *   - empty state shows the 5 starter questions; clicking one sends it.
 *   - a successful reply renders the assistant bubble + tool source badges.
 *   - a 4xx/5xx from the API renders a structured ErrorState with retry —
 *     never an uncaught JSON parse error, matching the established
 *     fetchJsonWithTimeout/ErrorState contract used across the app.
 *   - "Xoá hội thoại" clears all messages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

type FetchResponse = { status: number; jsonText: string | null };

async function renderPage(env: RenderEnv, respond: (body: unknown) => FetchResponse) {
  const requests: { body: unknown }[] = [];
  (globalThis as Record<string, unknown>).fetch = async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ body });
    const pick = respond(body);
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

test("empty state shows the 5 starter questions", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, () => ({ status: 200, jsonText: "{}" }));
    for (const q of [
      "Hiện có bao nhiêu lao động đang làm việc?",
      "Bộ phận nào đang thiếu người nhất theo Yêu cầu tuyển dụng?",
      "Có bao nhiêu lao động đang thiếu mã vân tay (IT Code)?",
      "Tổng hợp trạng thái Xác nhận điện tử hồ sơ ứng viên hiện tại.",
      "Dự báo khoảng trống nhân lực trong 30 ngày tới.",
    ]) {
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
      return { status: 200, jsonText: JSON.stringify({ reply: "OK sau khi thử lại.", toolCallLog: [], meta: { finishReason: "stop", iterations: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }) };
    });
    await ui.click("Có bao nhiêu lao động đang thiếu mã vân tay (IT Code)?");
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
      jsonText: JSON.stringify({ reply: "Trả lời.", toolCallLog: [], meta: { finishReason: "stop", iterations: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }),
    }));
    await ui.click("Dự báo khoảng trống nhân lực trong 30 ngày tới.");
    assert.match(ui.text(), /Trả lời\./);
    await ui.click("Xoá hội thoại");
    assert.doesNotMatch(ui.text(), /Trả lời\./);
    assert.match(ui.text(), /Đặt câu hỏi về nhân lực/);
  } finally {
    env.cleanup();
  }
});
