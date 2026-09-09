import "server-only";
import { getUserScope, hasPermission, type Session } from "@/lib/auth";
import { getCopilotProvider } from "./provider.ts";
import { getToolRegistry, getToolSchemas } from "./tool-registry.ts";
import { getActionRegistry, getActionSchemas } from "./action-registry.ts";
import { createProposal } from "./proposals.ts";
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
 *
 * ACTION_TOOLS are exposed to the SAME tool-calling loop as ordinary
 * read tools, but dispatching one here NEVER reaches ActionDefinition's
 * execute() — it only runs parseArgs -> validate() -> persists a PENDING
 * proposal (see proposals.ts). The only code path that can call
 * execute() is POST /api/ai-copilot/action/[proposalId]/execute, reachable
 * only via an explicit human click in the UI — there is no tool, no chat
 * message, and no model output that can reach it. This is a structural
 * guarantee, not a policy the model is trusted to follow.
 */
export async function runCopilotTurn(session: Session, question: string, rawHistory: unknown): Promise<OrchestratorResult> {
  const provider = getCopilotProvider();
  const readRegistry = getToolRegistry();
  const actionRegistry = getActionRegistry();
  const schemas = [...getToolSchemas(), ...getActionSchemas()];
  const history = sanitizeClientHistory(rawHistory, MAX_HISTORY_TURNS);

  const dispatch = async (name: string, rawArgs: unknown): Promise<ToolDispatchResult> => {
    const readTool = readRegistry.get(name);
    if (readTool) {
      let args: unknown;
      try {
        args = readTool.parseArgs(rawArgs);
      } catch (error) {
        if (error instanceof ToolExecutionError) return { ok: false, code: error.code, message: error.message };
        return { ok: false, code: "INVALID_ARGS", message: "Tham số không hợp lệ." };
      }
      const ctx: ToolContext = { session };
      try {
        const result = await readTool.execute(ctx, args);
        return { ok: true, data: result.data, source: result.source, truncated: result.truncated, totalCount: result.totalCount };
      } catch (error) {
        if (error instanceof ToolExecutionError) return { ok: false, code: error.code, message: error.message };
        console.error(`[ai-copilot] tool "${name}" failed`, error);
        return { ok: false, code: "INTERNAL", message: "Không thể truy vấn dữ liệu lúc này." };
      }
    }

    const actionDef = actionRegistry.get(name);
    if (actionDef) {
      const allowed = await hasPermission(session.role, actionDef.requiredPermission);
      if (!allowed) return { ok: false, code: "FORBIDDEN", message: "Bạn không có quyền thực hiện hành động này." };
      let args: unknown;
      try {
        args = actionDef.parseArgs(rawArgs);
      } catch (error) {
        return { ok: false, code: "INVALID_ARGS", message: error instanceof Error ? error.message : "Tham số không hợp lệ." };
      }
      const validation = await actionDef.validate({ session }, args);
      if (!validation.ok) return { ok: false, code: "INVALID_ARGS", message: validation.error };
      const scope = await getUserScope(session);
      const preview = actionDef.buildPreview(validation.payload);
      const proposal = await createProposal({
        action: actionDef.name,
        payload: validation.payload as Record<string, unknown>,
        humanReadablePreview: preview,
        departmentId: validation.departmentId,
        requiredPermission: actionDef.requiredPermission,
        dataScopeSnapshot: scope,
        createdBy: session.id,
      });
      return {
        ok: true,
        data: {
          proposalId: proposal.id,
          action: actionDef.name,
          humanReadablePreview: preview,
          expiresAt: proposal.expiresAt.toISOString(),
          requiresConfirmation: true,
        },
        source: { domains: ["ai_copilot_action"], asOf: new Date().toISOString() },
      };
    }

    return { ok: false, code: "NOT_FOUND", message: "Tool không tồn tại trong danh sách được phép." };
  };

  return runToolCallingLoop(provider, COPILOT_SYSTEM_PROMPT, schemas, history, question, dispatch, DEFAULT_ORCHESTRATOR_CONFIG);
}
