/**
 * AI COPILOT — ACTION_TOOLS contract (Phase 3 "Safe Action Copilot").
 * Pure (no "server-only", no DB) — deliberately a SEPARATE type surface
 * from types.ts's read-only ToolDefinition. An action is NEVER registered
 * in the READ_TOOLS registry (tool-registry.ts) and a read tool is NEVER
 * registered here (action-registry.ts) — see tool-registry.test.ts /
 * action-registry.test.ts for the structural proof.
 *
 * Two-step contract (mission-mandated, never collapsed into one step):
 *   1. PREPARE — parseArgs -> validate() (read-only: resolves names to
 *      IDs, checks Data Scope, checks business preconditions) -> if ok,
 *      the ROUTE persists an immutable proposal row. validate() itself
 *      NEVER writes to a business table.
 *   2. EXECUTE — only reachable via a human clicking "Xác nhận thực hiện"
 *      in the UI, which calls a route that re-authenticates, re-checks
 *      permission/Data Scope/expiry/idempotency against the FRESH request
 *      (see action-execution-guard.ts), then and ONLY then calls
 *      execute(), the one function in this whole module allowed to touch
 *      a business write table.
 */
import type { Session } from "@/lib/auth";
import type { JsonSchema } from "./types.ts";

export type ActionContext = { session: Session };

export type ActionValidationResult<TPayload> =
  | { ok: true; payload: TPayload; departmentId: string | null }
  | { ok: false; error: string };

export type ActionExecutionResult =
  | { ok: true; resultRef: Record<string, unknown> }
  | { ok: false; code: "VALIDATION" | "CONFLICT" | "INTERNAL"; message: string };

export type ActionDefinition<TArgs = Record<string, unknown>, TPayload = unknown> = {
  /** Stable name — what the model calls to PREPARE (never to execute) and what audit logs record. */
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Permission required both to prepare AND (re-checked live) to execute. */
  requiredPermission: string;
  /** Parses/validates raw (untrusted, model-supplied) JSON args — throws on anything unexpected, never eval/exec. */
  parseArgs: (raw: unknown) => TArgs;
  /**
   * READ-ONLY resolution + validation: resolve names to real IDs, check
   * Data Scope, check business preconditions. Returns the CANONICAL
   * payload that becomes immutable proposal state — this is what the
   * human is actually confirming, not the model's raw args. MUST NEVER
   * write to a business table.
   */
  validate: (ctx: ActionContext, args: TArgs) => Promise<ActionValidationResult<TPayload>>;
  /** Vietnamese, human-readable preview text built from the canonical payload — this is what the UI shows before confirmation. */
  buildPreview: (payload: TPayload) => string;
  /**
   * Performs the actual write via an EXISTING domain service — called
   * ONLY by the execute route, only after every re-check in
   * action-execution-guard.ts has passed. Must be idempotent from the
   * caller's perspective: the execute route only ever calls this once per
   * proposal (a second execute request short-circuits on the stored
   * result before reaching here) — see proposals.ts.
   */
  execute: (ctx: ActionContext, payload: TPayload) => Promise<ActionExecutionResult>;
};
