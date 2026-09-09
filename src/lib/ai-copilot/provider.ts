import "server-only";
import type { ToolCallingProvider } from "./types.ts";
import { createDeepSeekProviderFromConfig } from "./deepseek-provider.ts";

/**
 * Provider boundary for the AI Copilot — DeepSeek today, swappable later
 * without touching the orchestrator or any tool. Separate env vars from
 * the existing AI_PROVIDER/AI_MODEL/GEMINI_API_KEY (Workforce Intelligence
 * analyst, src/lib/ai/provider.ts) — that is a different, single-shot
 * feature with its own provider already configured.
 *
 * MODEL ROUTING (Phase 4 cost control) — `tier` picks which env var backs
 * the model: "fast" for simple lookup/synthesis, "reasoning" for complex
 * multi-step analysis. DEEPSEEK_FAST_MODEL is optional — unset, it falls
 * back to the same DEEPSEEK_MODEL "reasoning" uses, so this ships without
 * requiring two actual DeepSeek models to be configured (mission:
 * "Configuration may initially point both to the same model").
 */
export type ModelTier = "fast" | "reasoning";

export function getCopilotProvider(tier: ModelTier = "reasoning"): ToolCallingProvider {
  const model = tier === "fast" ? process.env.DEEPSEEK_FAST_MODEL || process.env.DEEPSEEK_MODEL : process.env.DEEPSEEK_MODEL;
  return createDeepSeekProviderFromConfig({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model,
  });
}
