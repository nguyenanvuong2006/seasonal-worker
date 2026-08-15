import test from "node:test";
import assert from "node:assert/strict";
import {
  AIProviderRequestError,
  GeminiProvider,
  MAX_AI_OUTPUT_CHARACTERS,
  createAIProviderFromConfig,
} from "./provider-core.ts";
import { AIProviderUnavailableError, type AIStructuredRequest } from "./types.ts";

const REQUEST: AIStructuredRequest = {
  operation: "WORKFORCE_ANALYZE",
  systemPrompt: "Only JSON",
  userPayload: { aggregate: 1 },
  maxOutputTokens: 100,
  timeoutMs: 10,
};

function responseWithText(text: string, status = 200): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("AI provider parses valid structured JSON", async () => {
  const provider = new GeminiProvider("test-key", "test-model", async () => responseWithText('{"ok":true}'));
  const result = await provider.generateStructured<{ ok: boolean }>(REQUEST);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.model, "test-model");
});

test("AI provider rejects malformed JSON without crashing", async () => {
  const provider = new GeminiProvider("test-key", "test-model", async () => responseWithText('{"broken":'));
  await assert.rejects(provider.generateStructured(REQUEST), (error: unknown) => error instanceof AIProviderRequestError && error.kind === "MALFORMED");
});

test("AI provider rejects empty response", async () => {
  const provider = new GeminiProvider("test-key", "test-model", async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
  await assert.rejects(provider.generateStructured(REQUEST), (error: unknown) => error instanceof AIProviderRequestError && error.kind === "EMPTY");
});

test("AI provider rejects overly long response", async () => {
  const provider = new GeminiProvider("test-key", "test-model", async () => responseWithText("x".repeat(MAX_AI_OUTPUT_CHARACTERS + 1)));
  await assert.rejects(provider.generateStructured(REQUEST), (error: unknown) => error instanceof AIProviderRequestError && error.kind === "TOO_LARGE");
});

test("AI provider timeout is bounded and returns safe error", async () => {
  const hangingFetch = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const provider = new GeminiProvider("test-key", "test-model", hangingFetch);
  await assert.rejects(provider.generateStructured({ ...REQUEST, timeoutMs: 2 }), (error: unknown) => error instanceof AIProviderRequestError && error.kind === "TIMEOUT");
});

test("AI provider maps HTTP 429 to safe rate-limit error", async () => {
  const provider = new GeminiProvider("test-key", "test-model", async () => new Response("rate detail must not leak", { status: 429 }));
  await assert.rejects(provider.generateStructured(REQUEST), (error: unknown) => error instanceof AIProviderRequestError && error.kind === "RATE_LIMIT" && !error.message.includes("rate detail"));
});

test("AI provider retries HTTP 500 once then returns safe upstream error", async () => {
  let calls = 0;
  const provider = new GeminiProvider("test-key", "test-model", async () => {
    calls += 1;
    return new Response("secret upstream body", { status: 500 });
  });
  await assert.rejects(provider.generateStructured(REQUEST), (error: unknown) => error instanceof AIProviderRequestError && error.kind === "UPSTREAM" && !error.message.includes("secret"));
  assert.equal(calls, 2);
});

test("AI provider maps network failure to safe error", async () => {
  const provider = new GeminiProvider("test-key", "test-model", async () => { throw new Error("socket details"); });
  await assert.rejects(provider.generateStructured(REQUEST), (error: unknown) => error instanceof AIProviderRequestError && error.kind === "NETWORK" && !error.message.includes("socket"));
});

test("AI provider unavailable when configuration or credentials are missing", () => {
  assert.throws(() => createAIProviderFromConfig({}), AIProviderUnavailableError);
  assert.throws(() => createAIProviderFromConfig({ provider: "gemini" }), AIProviderUnavailableError);
  assert.throws(() => createAIProviderFromConfig({ provider: "unsupported", apiKey: "x" }), AIProviderUnavailableError);
});
