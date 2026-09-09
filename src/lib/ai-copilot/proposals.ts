import "server-only";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { aiActionProposals, type AiActionProposal } from "@/db/schema";
import type { ProposalForGuard } from "./action-execution-guard.ts";

/**
 * AI COPILOT — action proposal persistence (Phase 3). This is the ONLY
 * file in the AI Copilot tree allowed to write to ai_action_proposals —
 * business-table writes (recruitmentRequests etc.) live exclusively
 * inside an ActionDefinition's own execute() function, never here.
 *
 * PROPOSAL_TTL_MS bounds how long a prepared-but-unconfirmed action stays
 * executable — short enough that a stale browser tab can't confirm a
 * long-forgotten proposal against since-changed data.
 */
export const PROPOSAL_TTL_MS = 15 * 60_000;

export type CreateProposalInput = {
  action: string;
  payload: Record<string, unknown>;
  humanReadablePreview: string;
  departmentId: string | null;
  requiredPermission: string;
  dataScopeSnapshot: string[] | null;
  createdBy: string;
};

export async function createProposal(input: CreateProposalInput): Promise<AiActionProposal> {
  const [row] = await db
    .insert(aiActionProposals)
    .values({
      action: input.action,
      status: "PENDING",
      payload: input.payload,
      humanReadablePreview: input.humanReadablePreview,
      departmentId: input.departmentId,
      requiredPermission: input.requiredPermission,
      dataScopeSnapshot: input.dataScopeSnapshot,
      idempotencyKey: randomUUID(),
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    })
    .returning();
  return row;
}

export async function getProposalById(id: string): Promise<AiActionProposal | null> {
  const [row] = await db.select().from(aiActionProposals).where(eq(aiActionProposals.id, id)).limit(1);
  return row ?? null;
}

export function toGuardShape(row: AiActionProposal): ProposalForGuard {
  return {
    id: row.id,
    status: row.status as ProposalForGuard["status"],
    createdBy: row.createdBy,
    requiredPermission: row.requiredPermission,
    departmentId: row.departmentId,
    expiresAt: row.expiresAt.toISOString(),
    executionResult: row.executionResult,
  };
}

export async function markConfirmed(id: string, confirmedBy: string): Promise<void> {
  await db.update(aiActionProposals).set({ status: "CONFIRMED", confirmedBy, confirmedAt: new Date(), updatedAt: new Date() }).where(eq(aiActionProposals.id, id));
}

export async function markExecuted(id: string, resultRef: Record<string, unknown>): Promise<void> {
  await db.update(aiActionProposals).set({ status: "EXECUTED", executedAt: new Date(), executionResult: resultRef, updatedAt: new Date() }).where(eq(aiActionProposals.id, id));
}

export async function markFailed(id: string, errorMessage: string): Promise<void> {
  await db.update(aiActionProposals).set({ status: "FAILED", errorMessage, updatedAt: new Date() }).where(eq(aiActionProposals.id, id));
}

export async function markExpired(id: string): Promise<void> {
  await db.update(aiActionProposals).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(aiActionProposals.id, id));
}

export async function markCancelled(id: string, cancelledBy: string): Promise<void> {
  await db.update(aiActionProposals).set({ status: "CANCELLED", confirmedBy: cancelledBy, updatedAt: new Date() }).where(eq(aiActionProposals.id, id));
}
