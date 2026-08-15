import type { AIProvider, AIProviderResult, AIStructuredRequest } from "./types.ts";
import { AIProviderUnavailableError } from "./types.ts";

export const MAX_AI_INPUT_CHARACTERS = 50_000;
export const MAX_AI_OUTPUT_CHARACTERS = 20_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class AIProviderRequestError extends Error {
  readonly kind: "TIMEOUT" | "RATE_LIMIT" | "UPSTREAM" | "MALFORMED" | "EMPTY" | "TOO_LARGE" | "NETWORK";
  constructor(kind: AIProviderRequestError["kind"], message: string) {
    super(message);
    this.name = "AIProviderRequestError";
    this.kind = kind;
  }
}

export function parseStructuredProviderText(text: string): unknown {
  if (!text.trim()) throw new AIProviderRequestError("EMPTY", "AI provider returned no structured content.");
  if (text.length > MAX_AI_OUTPUT_CHARACTERS) throw new AIProviderRequestError("TOO_LARGE", "AI provider response exceeded the configured size limit.");
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new AIProviderRequestError("MALFORMED", "AI provider returned malformed structured content.");
  }
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;

  constructor(apiKey: string, model: string, fetchFn: FetchLike = fetch) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchFn = fetchFn;
  }

  async generateStructured<T>(request: AIStructuredRequest): Promise<AIProviderResult<T>> {
    const payloadText = JSON.stringify(request.userPayload);
    if (payloadText.length > MAX_AI_INPUT_CHARACTERS) {
      throw new AIProviderRequestError("TOO_LARGE", "AI grounding payload exceeds the configured size limit.");
    }
    const startedAt = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: payloadText }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: request.maxOutputTokens },
    };

    let lastError: AIProviderRequestError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 429) throw new AIProviderRequestError("RATE_LIMIT", "AI provider rate limit reached.");
          throw new AIProviderRequestError("UPSTREAM", "AI provider temporarily unavailable.");
        }
        let json: Record<string, unknown>;
        try {
          json = await response.json() as Record<string, unknown>;
        } catch {
          throw new AIProviderRequestError("MALFORMED", "AI provider returned an invalid response envelope.");
        }
        const candidates = json.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined;
        const text = candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new AIProviderRequestError("EMPTY", "AI provider returned no structured content.");
        return {
          data: parseStructuredProviderText(text) as T,
          provider: this.name,
          model: this.model,
          durationMs: Date.now() - startedAt,
          estimatedInputTokens: Math.ceil((request.systemPrompt.length + payloadText.length) / 4),
        };
      } catch (error) {
        if (error instanceof AIProviderRequestError) lastError = error;
        else if (controller.signal.aborted || (error as Error)?.name === "AbortError") lastError = new AIProviderRequestError("TIMEOUT", "AI provider request timed out.");
        else lastError = new AIProviderRequestError("NETWORK", "AI provider network request failed.");
        if (attempt === 0 && (lastError.kind === "TIMEOUT" || lastError.kind === "UPSTREAM" || lastError.kind === "NETWORK")) continue;
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new AIProviderRequestError("NETWORK", "AI provider request failed.");
  }
}

export function createAIProviderFromConfig(
  config: { provider?: string; model?: string; apiKey?: string },
  fetchFn: FetchLike = fetch,
): AIProvider {
  const provider = (config.provider ?? "").trim().toLowerCase();
  if (!provider) throw new AIProviderUnavailableError("AI provider is not configured.");
  if (provider !== "gemini") throw new AIProviderUnavailableError("Configured AI provider is not supported.");
  if (!config.apiKey?.trim()) throw new AIProviderUnavailableError("AI provider credentials are not configured.");
  return new GeminiProvider(config.apiKey.trim(), config.model?.trim() || "gemini-2.5-flash", fetchFn);
}
