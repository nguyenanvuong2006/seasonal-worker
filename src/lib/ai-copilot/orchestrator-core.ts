/**
 * AI COPILOT — pure multi-turn tool-calling loop. No "server-only", no DB,
 * no RBAC — the CALLER supplies an already-authorization-bound `dispatch`
 * function (see orchestrator.ts) so this file can be exercised with a fake
 * provider + fake dispatcher under plain node:test, exactly like
 * deepseek-provider.test.ts exercises DeepSeekProvider with a fake fetch.
 *
 * Security invariant this file exists to protect: RBAC/Data Scope must be
 * re-evaluated on EVERY tool call, never trusted from a prior turn or from
 * conversation history. This loop never caches or reuses a tool result
 * across iterations — every tool_calls response triggers a fresh dispatch().
 */
import type { ChatMessage, ChatCompletionRequest, ToolCallingProvider, ToolSchema, ToolSource } from "./types.ts";

export type SanitizedHistoryTurn = { role: "user" | "assistant"; content: string };

/**
 * Client-supplied conversation history is DATA, not trusted structure —
 * this is the single choke point that guarantees a client can never inject a
 * fake "tool" message (which would otherwise let it forge a tool result the
 * model would treat as ground truth) or a fake assistant tool-call. Only
 * plain user/assistant text turns survive; everything else is silently
 * dropped, and the most recent `maxTurns` are kept.
 */
export function sanitizeClientHistory(raw: unknown, maxTurns: number): SanitizedHistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: SanitizedHistoryTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as Record<string, unknown>).role;
    const content = (item as Record<string, unknown>).content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      out.push({ role, content: content.slice(0, 4000) });
    }
  }
  return out.slice(-maxTurns);
}

export type ToolDispatchResult =
  | { ok: true; data: unknown; source: ToolSource; truncated?: boolean; totalCount?: number }
  | { ok: false; code: string; message: string };

/** Bound to one authenticated session by the caller — see orchestrator.ts. */
export type ToolDispatcher = (name: string, rawArgs: unknown) => Promise<ToolDispatchResult>;

export type OrchestratorConfig = {
  /** Hard cap on model round-trips — bounds cost and prevents infinite loops. */
  maxIterations: number;
  /** Hard cap on tool calls accepted per model turn. */
  maxToolCallsPerIteration: number;
  maxOutputTokens: number;
  timeoutMs: number;
};

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxIterations: 6,
  maxToolCallsPerIteration: 5,
  maxOutputTokens: 900,
  timeoutMs: 20_000,
};

export type ToolCallLogEntry = { name: string; ok: boolean; durationMs: number; truncated?: boolean };

export type OrchestratorResult = {
  reply: string;
  finishReason: "stop" | "max_iterations";
  toolCallLog: ToolCallLogEntry[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  iterations: number;
};

export async function runToolCallingLoop(
  provider: ToolCallingProvider,
  systemPrompt: string,
  toolSchemas: ToolSchema[],
  history: SanitizedHistoryTurn[],
  question: string,
  dispatch: ToolDispatcher,
  config: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG,
): Promise<OrchestratorResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
    { role: "user", content: question },
  ];
  const toolCallLog: ToolCallLogEntry[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    const request: ChatCompletionRequest = {
      messages,
      tools: toolSchemas,
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
    };
    const result = await provider.chatCompletion(request);
    if (result.usage) {
      usage.promptTokens += result.usage.promptTokens;
      usage.completionTokens += result.usage.completionTokens;
      usage.totalTokens += result.usage.totalTokens;
    }
    messages.push(result.message);
    const calls = result.message.toolCalls ?? [];
    if (result.finishReason !== "tool_calls" || calls.length === 0) {
      return {
        reply: result.message.content?.trim() || "Không có nội dung trả lời.",
        finishReason: "stop",
        toolCallLog,
        usage,
        iterations: iteration + 1,
      };
    }

    const boundedCalls = calls.slice(0, config.maxToolCallsPerIteration);
    const overflowCalls = calls.slice(config.maxToolCallsPerIteration);

    for (const call of boundedCalls) {
      const startedAt = Date.now();
      let parsedArgs: unknown = {};
      let parseError: string | null = null;
      try {
        parsedArgs = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
      } catch {
        parseError = "Tham số tool không hợp lệ (không phải JSON).";
      }

      let ok = false;
      let truncated: boolean | undefined;
      let toolMessageContent: string;
      if (parseError) {
        toolMessageContent = JSON.stringify({ error: parseError });
      } else {
        let dispatched: ToolDispatchResult;
        try {
          // Every single call re-enters dispatch(), which re-resolves RBAC/Data
          // Scope from the session — nothing here is cached from a prior turn.
          dispatched = await dispatch(call.name, parsedArgs);
        } catch {
          dispatched = { ok: false, code: "INTERNAL", message: "Tool nội bộ gặp lỗi không mong muốn." };
        }
        ok = dispatched.ok;
        if (dispatched.ok) {
          truncated = dispatched.truncated;
          toolMessageContent = JSON.stringify({
            data: dispatched.data,
            source: dispatched.source,
            truncated: dispatched.truncated,
            totalCount: dispatched.totalCount,
          });
        } else {
          toolMessageContent = JSON.stringify({ error: dispatched.message, code: dispatched.code });
        }
      }
      toolCallLog.push({ name: call.name, ok, durationMs: Date.now() - startedAt, truncated });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: toolMessageContent });
    }

    for (const call of overflowCalls) {
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify({ error: "Vượt quá số lượng tool được gọi trong 1 lượt." }),
      });
      toolCallLog.push({ name: call.name, ok: false, durationMs: 0 });
    }
  }

  return {
    reply: "Câu hỏi này cần quá nhiều bước tra cứu để trả lời an toàn trong giới hạn hiện tại — vui lòng hỏi cụ thể hơn hoặc chia nhỏ câu hỏi.",
    finishReason: "max_iterations",
    toolCallLog,
    usage,
    iterations: config.maxIterations,
  };
}
