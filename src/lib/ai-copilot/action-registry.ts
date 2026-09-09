import "server-only";
import { recruitmentRequestActions } from "./actions/recruitment-request.ts";
import type { ActionDefinition } from "./action-types.ts";
import type { JsonSchema } from "./types.ts";
import { getToolRegistry } from "./tool-registry.ts";

/**
 * ACTION_TOOLS registry — DELIBERATELY SEPARATE from READ_TOOLS
 * (tool-registry.ts). A read tool is never registered here; an action is
 * never registered there. See action-registry.test.ts for the structural
 * proof (no name collisions between the two registries, and every
 * ActionDefinition here truly has a two-step prepare/execute shape).
 */
const ALL_ACTIONS: ActionDefinition<any, any>[] = [...recruitmentRequestActions];

const REGISTRY = new Map<string, ActionDefinition<any, any>>(ALL_ACTIONS.map((a) => [a.name, a]));

if (REGISTRY.size !== ALL_ACTIONS.length) {
  throw new Error("AI Copilot action registry has a duplicate action name — every action name must be unique.");
}

const readToolNames = new Set(getToolRegistry().keys());
for (const name of REGISTRY.keys()) {
  if (readToolNames.has(name)) {
    throw new Error(`AI Copilot action "${name}" collides with a READ_TOOLS name — action and read-tool names must never overlap.`);
  }
}

export function getActionRegistry(): ReadonlyMap<string, ActionDefinition<any, any>> {
  return REGISTRY;
}

export type ActionSchema = { name: string; description: string; parameters: JsonSchema };

export function getActionSchemas(): ActionSchema[] {
  return ALL_ACTIONS.map((a) => ({ name: a.name, description: a.description, parameters: a.parameters }));
}
