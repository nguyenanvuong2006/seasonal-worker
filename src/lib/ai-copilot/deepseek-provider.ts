import {
  ToolCallingProviderError,
  type ChatCompletionRequest,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatUsage,
  type ToolCall,
  type ToolCallingProvider,
} from "./types.ts";

/**
 * DeepSeek tool-calling provider — talks to DeepSeek's OpenAI-compatible
 * Chat Completions API (POST {baseUrl}/chat/completions) via plain fetch,
 * same convention as src/lib/ai/provider-core.ts's GeminiProvider
 * (AbortController timeout, one retry on transient failure, a small typed
 * error taxonomy) — no SDK dependency added.
 *
 * NEVER receives raw DB credentials or an execute_sql-shaped tool — see
 * tool-registry.ts. This file only talks to DeepSeek; it knows nothing
 * about Postgres.
 */

const MAX_OUTPUT_CHARACTERS = 20_000;

export function mapDeepSeekMessageToChatMessage(raw: Record<string, unknown>): ChatMessage {
  const rawToolCalls = raw.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined;
  const toolCalls: ToolCall[] | undefined = rawToolCalls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    argumentsJson: tc.function.arguments,
  }));
  return {
    role: "assistant",
    content: typeof raw.content === "string" ? raw.content : null,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function chatMessageToDeepSeekPayload(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content ?? "" };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argumentsJson },
      })),
    };
  }
  return { role: message.role, content: message.content ?? "" };
}

function mapFinishReason(reason: unknown): ChatCompletionResult["finishReason"] {
  if (reason === "stop" || reason === "tool_calls" || reason === "length" || reason === "content_filter") return reason;
  return "unknown";
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class DeepSeekProvider implements ToolCallingProvider {
  readonly name = "deepseek";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(apiKey: string, baseUrl: string, model: string, fetchFn: FetchLike = fetch) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.fetchFn = fetchFn;
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const startedAt = Date.now();
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages: request.messages.map(chatMessageToDeepSeekPayload),
      tools: request.tools.length
        ? request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
        : undefined,
      tool_choice: request.tools.length ? "auto" : undefined,
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature ?? 0.1,
    };

    let lastError: ToolCallingProviderError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 429) throw new ToolCallingProviderError("RATE_LIMIT", "DeepSeek rate limit reached.");
          if (response.status >= 500) throw new ToolCallingProviderError("UPSTREAM", "DeepSeek temporarily unavailable.");
          throw new ToolCallingProviderError("UPSTREAM", `DeepSeek request rejected (HTTP ${response.status}).`);
        }
        let json: Record<string, unknown>;
        try {
          json = (await response.json()) as Record<string, unknown>;
        } catch {
          throw new ToolCallingProviderError("MALFORMED", "DeepSeek returned an invalid response envelope.");
        }
        const choices = json.choices as { message?: Record<string, unknown>; finish_reason?: string }[] | undefined;
        const choice = choices?.[0];
        if (!choice?.message) throw new ToolCallingProviderError("EMPTY", "DeepSeek returned no message.");
        const rawContent = choice.message.content;
        if (typeof rawContent === "string" && rawContent.length > MAX_OUTPUT_CHARACTERS) {
          throw new ToolCallingProviderError("TOO_LARGE", "DeepSeek response exceeded the configured size limit.");
        }
        const usageRaw = json.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
        const usage: ChatUsage | null = usageRaw
          ? { promptTokens: usageRaw.prompt_tokens ?? 0, completionTokens: usageRaw.completion_tokens ?? 0, totalTokens: usageRaw.total_tokens ?? 0 }
          : null;
        return {
          message: mapDeepSeekMessageToChatMessage(choice.message),
          finishReason: mapFinishReason(choice.finish_reason),
          usage,
          provider: this.name,
          model: this.model,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        if (error instanceof ToolCallingProviderError) lastError = error;
        else if (controller.signal.aborted || (error as Error)?.name === "AbortError") lastError = new ToolCallingProviderError("TIMEOUT", "DeepSeek request timed out.");
        else lastError = new ToolCallingProviderError("NETWORK", "DeepSeek network request failed.");
        // Only retry once, and only for transient failure classes — never retry MALFORMED/EMPTY/TOO_LARGE/RATE_LIMIT.
        if (attempt === 0 && (lastError.kind === "TIMEOUT" || lastError.kind === "UPSTREAM" || lastError.kind === "NETWORK")) continue;
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new ToolCallingProviderError("NETWORK", "DeepSeek request failed.");
  }
}

export function createDeepSeekProviderFromConfig(
  config: { apiKey?: string; baseUrl?: string; model?: string },
  fetchFn: FetchLike = fetch,
): ToolCallingProvider {
  if (!config.apiKey?.trim()) {
    throw new ToolCallingProviderError("UNAVAILABLE", "DEEPSEEK_API_KEY chưa được cấu hình.");
  }
  return new DeepSeekProvider(
    config.apiKey.trim(),
    config.baseUrl?.trim() || "https://api.deepseek.com",
    config.model?.trim() || "deepseek-chat",
    fetchFn,
  );
}
