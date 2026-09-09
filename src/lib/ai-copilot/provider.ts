import "server-only";
import type { ToolCallingProvider } from "./types.ts";
import { createDeepSeekProviderFromConfig } from "./deepseek-provider.ts";

/**
 * Provider boundary for the AI Copilot — DeepSeek today, swappable later
 * without touching the orchestrator or any tool. Separate env vars from
 * the existing AI_PROVIDER/AI_MODEL/GEMINI_API_KEY (Workforce Intelligence
 * analyst, src/lib/ai/provider.ts) — that is a different, single-shot
 * feature with its own provider already configured.
 */
export function getCopilotProvider(): ToolCallingProvider {
  return createDeepSeekProviderFromConfig({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL,
  });
}
