import "server-only";
import { organizationTools } from "./tools/organization.ts";
import { workerTools } from "./tools/workers.ts";
import { recruitmentTools } from "./tools/recruitment.ts";
import { workforceRequestTools } from "./tools/workforce-requests.ts";
import { outlookTools } from "./tools/outlook.ts";
import { movementTools } from "./tools/movements.ts";
import { fingerprintTools } from "./tools/fingerprint.ts";
import { dailyApplicationTools } from "./tools/daily-applications.ts";
import { documentTools } from "./tools/documents.ts";
import { analyticsTools } from "./tools/analytics.ts";
import { knowledgeTools } from "./tools/knowledge.ts";
import { worker360ProfileTools } from "./tools/worker-360-profile.ts";
import type { ToolDefinition, ToolSchema } from "./types.ts";

/**
 * ALLOWLISTED tool registry — the ONLY tools the AI Copilot's DeepSeek model
 * can call. Every entry is read-only (no create/update/delete anywhere in
 * this tree) and internally re-resolves the caller's Data Scope from
 * ToolContext.session (never a caller/model-supplied scope) — see each
 * tools/*.ts file for which authoritative service it reuses.
 *
 * There is deliberately NO execute_sql/raw-query tool and NO way to add one
 * through this registry — a tool is a named, schema-typed function, never a
 * pass-through to the database.
 */
const ALL_TOOLS: ToolDefinition<any, any>[] = [
  ...organizationTools,
  ...workerTools,
  ...recruitmentTools,
  ...workforceRequestTools,
  ...outlookTools,
  ...movementTools,
  ...fingerprintTools,
  ...dailyApplicationTools,
  ...documentTools,
  ...analyticsTools,
  ...knowledgeTools,
  ...worker360ProfileTools,
];

const REGISTRY = new Map<string, ToolDefinition<any, any>>(ALL_TOOLS.map((t) => [t.name, t]));

if (REGISTRY.size !== ALL_TOOLS.length) {
  throw new Error("AI Copilot tool registry has a duplicate tool name — every tool name must be unique.");
}

export function getToolRegistry(): ReadonlyMap<string, ToolDefinition<any, any>> {
  return REGISTRY;
}

export function getToolSchemas(): ToolSchema[] {
  return ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
