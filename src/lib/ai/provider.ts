import "server-only";
import type { AIProvider } from "./types.ts";
import { createAIProviderFromConfig } from "./provider-core.ts";

export function getAIProvider(): AIProvider {
  return createAIProviderFromConfig({
    provider: process.env.AI_PROVIDER,
    model: process.env.AI_MODEL,
    apiKey: process.env.GEMINI_API_KEY,
  });
}
