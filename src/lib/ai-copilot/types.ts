/**
 * AI COPILOT — shared types. Pure (no "server-only", no DB) so tool
 * registries, the orchestrator loop, and route handlers can all import
 * this without pulling server-only code into a place that doesn't need it.
 */
import type { Session } from "@/lib/auth";

/* ============================================================
   TOOL-CALLING PROVIDER BOUNDARY
   ------------------------------------------------------------
   Deliberately NOT the same shape as src/lib/ai/types.ts's AIProvider
   (single-shot "generateStructured" — used by the existing Workforce
   Intelligence AI analyst). Tool calling is inherently multi-turn: the
   model can return zero or more tool calls per turn, and the orchestrator
   feeds tool RESULTS back as new messages. Forcing that into the
   single-shot interface would be the wrong abstraction. This interface is
   provider-agnostic (DeepSeek today; any OpenAI-compatible tool-calling
   API tomorrow) — see deepseek-provider.ts for the concrete implementation.
   ============================================================ */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON text as returned by the model — the orchestrator parses and validates it, never trusts it blindly. */
  argumentsJson: string;
};

export type ChatMessage = {
  role: ChatRole;
  /** null when an assistant message is tool-calls-only. */
  content: string | null;
  /** Only present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Only present on role: "tool" messages — must match the ToolCall.id it answers. */
  toolCallId?: string;
  /** Only present on role: "tool" messages — the tool name (informational, matches the registry). */
  name?: string;
};

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: false;
};

export type ToolSchema = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ChatCompletionRequest = {
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
};

export type ChatFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

export type ChatUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

export type ChatCompletionResult = {
  message: ChatMessage;
  finishReason: ChatFinishReason;
  usage: ChatUsage | null;
  provider: string;
  model: string;
  durationMs: number;
};

export interface ToolCallingProvider {
  readonly name: string;
  readonly model: string;
  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}

export class ToolCallingProviderError extends Error {
  readonly kind: "TIMEOUT" | "RATE_LIMIT" | "UPSTREAM" | "MALFORMED" | "EMPTY" | "TOO_LARGE" | "NETWORK" | "UNAVAILABLE";
  constructor(kind: ToolCallingProviderError["kind"], message: string) {
    super(message);
    this.name = "ToolCallingProviderError";
    this.kind = kind;
  }
}

/* ============================================================
   TOOL REGISTRY CONTRACT
   ------------------------------------------------------------
   Every tool takes the AUTHENTICATED SESSION, never a caller/model-
   supplied scope — Data Scope is re-resolved from the session on every
   single tool execution (see orchestrator.ts), exactly like
   workforce-intelligence/tools.ts already does for the existing AI
   feature. A tool's `args` may narrow WITHIN the session's own scope
   (e.g. "only department X"); it must never be able to widen it — that
   is enforced inside each tool's implementation by intersecting the
   requested filter with getUserScope(session), never trusting the filter
   alone.
   ============================================================ */

export type ToolSource = {
  /** Business domains this answer is grounded in, e.g. ["planning", "workforce"]. */
  domains: string[];
  /** ISO timestamp this data reflects — "now" for live queries, or the historical asOf. */
  asOf: string;
};

export type ToolResult<T> = {
  data: T;
  source: ToolSource;
  /** Set when the underlying result set was larger than the tool's cap and had to be truncated. */
  truncated?: boolean;
  /** Present alongside `truncated` — the real total before truncation. */
  totalCount?: number;
};

export type ToolContext = { session: Session };

export type ToolDefinition<TArgs = Record<string, unknown>, TResult = unknown> = {
  /** Stable name — this is what the model calls and what audit logs record. Never rename without a migration plan. */
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Parses/validates raw (untrusted, model-supplied) JSON args into TArgs — throws on anything unexpected. Never eval/exec. */
  parseArgs: (raw: unknown) => TArgs;
  execute: (ctx: ToolContext, args: TArgs) => Promise<ToolResult<TResult>>;
};

export class ToolExecutionError extends Error {
  readonly code: "INVALID_ARGS" | "FORBIDDEN" | "NOT_FOUND" | "INTERNAL";
  constructor(code: ToolExecutionError["code"], message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}
