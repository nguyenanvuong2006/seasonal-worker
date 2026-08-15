export type AIStructuredRequest = {
  operation: "WORKFORCE_ANALYZE" | "WORKFORCE_CHAT";
  systemPrompt: string;
  userPayload: unknown;
  maxOutputTokens: number;
  timeoutMs: number;
};

export type AIProviderResult<T> = {
  data: T;
  provider: string;
  model: string;
  durationMs: number;
  estimatedInputTokens: number;
};

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<T>(request: AIStructuredRequest): Promise<AIProviderResult<T>>;
}

export class AIProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderUnavailableError";
  }
}
