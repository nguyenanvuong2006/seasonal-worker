import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekProvider, createDeepSeekProviderFromConfig } from "./deepseek-provider.ts";
import { ToolCallingProviderError, type ChatCompletionRequest } from "./types.ts";

const REQUEST: ChatCompletionRequest = {
  messages: [{ role: "system", content: "test" }, { role: "user", content: "hi" }],
  tools: [{ name: "get_thing", description: "desc", parameters: { type: "object", properties: {} } }],
  maxOutputTokens: 100,
  timeoutMs: 10,
};

function respond(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("plain text answer (no tool calls) is parsed with finishReason=stop", async () => {
  const provider = new DeepSeekProvider("key", "https://api.example", "test-model", async () =>
    respond({ choices: [{ message: { role: "assistant", content: "Hiện có 128 lao động." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  );
  const result = await provider.chatCompletion(REQUEST);
  assert.equal(result.message.content, "Hiện có 128 lao động.");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  assert.equal(result.model, "test-model");
});

test("tool call response is parsed into ToolCall[] with finishReason=tool_calls", async () => {
  const provider = new DeepSeekProvider("key", "https://api.example", "test-model", async () =>
    respond({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_current_workforce", arguments: '{"departmentId":null}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
  );
  const result = await provider.chatCompletion(REQUEST);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.message.toolCalls?.length, 1);
  assert.equal(result.message.toolCalls?.[0].name, "get_current_workforce");
  assert.equal(result.message.toolCalls?.[0].argumentsJson, '{"departmentId":null}');
});

test("rejects malformed JSON envelope without crashing", async () => {
  const provider = new DeepSeekProvider("key", "https://api.example", "test-model", async () => new Response("not json", { status: 200 }));
  await assert.rejects(provider.chatCompletion(REQUEST), (e: unknown) => e instanceof ToolCallingProviderError && e.kind === "MALFORMED");
});

test("rejects empty choices", async () => {
  const provider = new DeepSeekProvider("key", "https://api.example", "test-model", async () => respond({ choices: [] }));
  await assert.rejects(provider.chatCompletion(REQUEST), (e: unknown) => e instanceof ToolCallingProviderError && e.kind === "EMPTY");
});

test("maps HTTP 429 to safe RATE_LIMIT error, never leaks the raw body", async () => {
  const provider = new DeepSeekProvider("key", "https://api.example", "test-model", async () => new Response("rate detail must not leak", { status: 429 }));
  await assert.rejects(provider.chatCompletion(REQUEST), (e: unknown) => e instanceof ToolCallingProviderError && e.kind === "RATE_LIMIT" && !e.message.includes("rate detail"));
});

test("retries HTTP 500 once then returns a safe UPSTREAM error, never leaks the raw body", async () => {
  let calls = 0;
  const provider = new DeepSeekProvider("key", "https://api.example", "test-model", async () => {
    calls += 1;
    return new Response("secret upstream body", { status: 500 });
  });
  await assert.rejects(provider.chatCompletion(REQUEST), (e: unknown) => e instanceof ToolCallingProviderError && e.kind === "UPSTREAM" && !e.message.includes("secret"));
  assert.equal(calls, 2);
});

test("timeout is bounded and returns a safe TIMEOUT error", async () => {
  const hangingFetch = (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const provider = new DeepSeekProvider("key", "https://api.example", "test-model", hangingFetch);
  await assert.rejects(provider.chatCompletion({ ...REQUEST, timeoutMs: 2 }), (e: unknown) => e instanceof ToolCallingProviderError && e.kind === "TIMEOUT");
});

test("never retries on MALFORMED/EMPTY (only one call made)", async () => {
  let calls = 0;
  const provider = new DeepSeekProvider("key", "https://api.example", "test-model", async () => {
    calls += 1;
    return respond({ choices: [] });
  });
  await assert.rejects(provider.chatCompletion(REQUEST));
  assert.equal(calls, 1, "EMPTY must not be retried — it is a valid response shape, not a transient failure");
});

test("request body sends the API key as a Bearer header, never in the URL or body plaintext outside Authorization", async () => {
  let capturedInit: RequestInit | undefined;
  let capturedUrl: string | URL | Request | undefined;
  const provider = new DeepSeekProvider("super-secret-key", "https://api.example", "test-model", async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return respond({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  });
  await provider.chatCompletion(REQUEST);
  assert.equal(String(capturedUrl), "https://api.example/chat/completions");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer super-secret-key");
  assert.ok(!String(capturedUrl).includes("super-secret-key"));
});

test("createDeepSeekProviderFromConfig fails closed when DEEPSEEK_API_KEY is missing", () => {
  assert.throws(
    () => createDeepSeekProviderFromConfig({ apiKey: undefined }),
    (e: unknown) => e instanceof ToolCallingProviderError && e.kind === "UNAVAILABLE",
  );
});

test("createDeepSeekProviderFromConfig applies sane defaults for baseUrl/model", () => {
  const provider = createDeepSeekProviderFromConfig({ apiKey: "k" });
  assert.equal(provider.name, "deepseek");
  assert.equal(provider.model, "deepseek-chat");
});
