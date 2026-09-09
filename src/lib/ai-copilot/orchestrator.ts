import "server-only";
import type { Session } from "@/lib/auth";
import { getCopilotProvider } from "./provider.ts";
import { getToolRegistry, getToolSchemas } from "./tool-registry.ts";
import { COPILOT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { ToolExecutionError, type ToolContext } from "./types.ts";
import {
  runToolCallingLoop,
  sanitizeClientHistory,
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorResult,
  type ToolDispatchResult,
} from "./orchestrator-core.ts";

const MAX_HISTORY_TURNS = 8;

/**
 * Server boundary for the AI Copilot orchestrator — binds the pure
 * runToolCallingLoop() (orchestrator-core.ts) to the REAL DeepSeek provider,
 * the REAL tool registry, and one authenticated Session. Called by the API
 * route AFTER requirePermission() has already gated the request; `session`
 * here is the single source of truth every tool call re-derives Data Scope
 * from — nothing about authorization is cached or passed from the client.
 */
export async function runCopilotTurn(session: Session, question: string, rawHistory: unknown): Promise<OrchestratorResult> {
  const provider = getCopilotProvider();
  const registry = getToolRegistry();
  const schemas = getToolSchemas();
  const history = sanitizeClientHistory(rawHistory, MAX_HISTORY_TURNS);

  const dispatch = async (name: string, rawArgs: unknown): Promise<ToolDispatchResult> => {
    const tool = registry.get(name);
    if (!tool) return { ok: false, code: "NOT_FOUND", message: "Tool không tồn tại trong danh sách được phép." };
    let args: unknown;
    try {
      args = tool.parseArgs(rawArgs);
    } catch (error) {
      if (error instanceof ToolExecutionError) return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: "INVALID_ARGS", message: "Tham số không hợp lệ." };
    }
    const ctx: ToolContext = { session };
    try {
      const result = await tool.execute(ctx, args);
      return { ok: true, data: result.data, source: result.source, truncated: result.truncated, totalCount: result.totalCount };
    } catch (error) {
      if (error instanceof ToolExecutionError) return { ok: false, code: error.code, message: error.message };
      console.error(`[ai-copilot] tool "${name}" failed`, error);
      return { ok: false, code: "INTERNAL", message: "Không thể truy vấn dữ liệu lúc này." };
    }
  };

  return runToolCallingLoop(provider, COPILOT_SYSTEM_PROMPT, schemas, history, question, dispatch, DEFAULT_ORCHESTRATOR_CONFIG);
}
