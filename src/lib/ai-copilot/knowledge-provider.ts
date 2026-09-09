/**
 * AI COPILOT — Knowledge/RAG foundation (Phase 4). Pure interface + a
 * mock implementation — NO Qdrant, NO vector DB dependency added this
 * phase (mission: "Do NOT add Qdrant infrastructure/cost/dependency now
 * unless technically necessary"). The interface itself is the future
 * adapter boundary: swapping MockKnowledgeProvider for a real one later
 * (Postgres full-text, Qdrant, or anything else) never touches the tool
 * that calls it (tools/knowledge.ts) or the orchestrator.
 *
 * STRUCTURED DATA VS KNOWLEDGE — kept strictly separate on purpose:
 *   - Operational numbers (headcount, demand, gap, recruitment stats...)
 *     ALWAYS come from the Postgres-backed tools in tools/*.ts.
 *   - Policy/procedure/SOP questions go through THIS provider instead.
 *   - A mixed question calls both in the same turn (the orchestrator
 *     already supports multiple tool calls per turn) — the model then
 *     synthesizes, but every operational number in that synthesis still
 *     has to have come from a structured tool, never from a knowledge
 *     search result (see system-prompt.ts's Phase 4 rules).
 *
 * MockKnowledgeProvider deliberately returns NO results (available:
 * false) — there is no real knowledge base loaded yet, and inventing
 * placeholder policy text would violate the mission's own "no
 * unsupported policy claims" rule. This mock proves the plumbing (the
 * interface, the citation DTO, the tool routing, the UI's citation
 * rendering) without ever fabricating a policy answer.
 */

export type KnowledgeSourceType = "POLICY" | "SOP" | "PROCEDURE" | "FAQ" | "TEMPLATE" | "MANUAL";

export type KnowledgeCitation = {
  documentId: string;
  title: string;
  section: string | null;
  snippet: string;
  sourceType: KnowledgeSourceType;
  updatedAt: string;
};

export type KnowledgeSearchResult = {
  results: KnowledgeCitation[];
  /** false when no real knowledge base is loaded — the caller must say so, never fabricate a policy answer to fill the gap. */
  available: boolean;
};

export interface KnowledgeProvider {
  readonly name: string;
  search(query: string, scope: string[] | null, limit: number): Promise<KnowledgeSearchResult>;
}

export class MockKnowledgeProvider implements KnowledgeProvider {
  readonly name = "mock";
  async search(_query: string, _scope: string[] | null, _limit: number): Promise<KnowledgeSearchResult> {
    return { results: [], available: false };
  }
}

export function getKnowledgeProvider(): KnowledgeProvider {
  return new MockKnowledgeProvider();
}
