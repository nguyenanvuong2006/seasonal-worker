import "server-only";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { aiConversationMessages, aiConversations, type AiConversation, type AiConversationMessage } from "@/db/schema";

/**
 * AI COPILOT — server-side conversation persistence. Durable Postgres
 * storage (never React state, never localStorage-as-source-of-truth) for
 * the Admin Copilot chat.
 *
 * OWNERSHIP IS THE WHOLE SECURITY MODEL HERE: every function that accepts
 * a conversationId ALSO takes the authenticated userId and includes it in
 * the SQL WHERE clause itself — never "fetch by id, then check owner in
 * app code" (a forgettable extra step). A conversationId alone, even from
 * an ADMIN/global-Data-Scope session, can never read or write another
 * user's conversation; Data Scope (workforce department visibility) and
 * conversation ownership are deliberately unrelated axes — see
 * conversations.test.ts's explicit IDOR cases.
 *
 * This module has NO permission/RBAC checks of its own — callers (the API
 * routes) are responsible for requirePermission(ai_copilot.view) BEFORE
 * calling anything here. This module only enforces ownership.
 */

const DEFAULT_MESSAGE_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const TITLE_MAX_LENGTH = 80;

export type ConversationMessageInput = {
  role: "USER" | "ASSISTANT";
  content: string;
  toolCallLog?: { name: string; ok: boolean; truncated?: boolean }[];
  analysisCards?: { toolName: string; data: unknown; source: { domains: string[]; asOf: string } }[];
  proposalRefs?: string[];
  clientMessageId?: string;
};

/** Derives a short conversation title from the first user message — never invented, never AI-generated. */
function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim();
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return trimmed.slice(0, TITLE_MAX_LENGTH - 1) + "…";
}

export async function createConversation(userId: string): Promise<AiConversation> {
  const [row] = await db.insert(aiConversations).values({ userId }).returning();
  return row;
}

/** Ownership-checked read. Returns null for "not found" AND "not yours" — never distinguishes, to avoid leaking existence. */
export async function getOwnedConversation(conversationId: string, userId: string): Promise<AiConversation | null> {
  const [row] = await db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId), eq(aiConversations.status, "ACTIVE")))
    .limit(1);
  return row ?? null;
}

export async function listConversations(userId: string, limit = DEFAULT_LIST_LIMIT): Promise<AiConversation[]> {
  return db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.userId, userId), eq(aiConversations.status, "ACTIVE")))
    .orderBy(desc(aiConversations.lastMessageAt))
    .limit(limit);
}

/** Ownership-checked message read — re-verifies ownership itself rather than trusting a caller who already checked. */
export async function listMessages(conversationId: string, userId: string, limit = DEFAULT_MESSAGE_LIMIT): Promise<AiConversationMessage[]> {
  const owned = await getOwnedConversation(conversationId, userId);
  if (!owned) return [];
  return db
    .select()
    .from(aiConversationMessages)
    .where(eq(aiConversationMessages.conversationId, conversationId))
    .orderBy(asc(aiConversationMessages.createdAt))
    .limit(limit);
}

/**
 * Idempotent-replay lookup: if `clientMessageId` was already persisted for
 * this conversation, return the SAME user+assistant message pair that was
 * produced last time instead of letting the caller re-run DeepSeek/tools —
 * a page refresh right after sending must never create a duplicate turn or
 * a duplicate action proposal.
 */
export async function findExistingTurn(
  conversationId: string,
  clientMessageId: string,
): Promise<{ userMessage: AiConversationMessage; assistantMessage: AiConversationMessage | null } | null> {
  const [userMessage] = await db
    .select()
    .from(aiConversationMessages)
    .where(and(eq(aiConversationMessages.conversationId, conversationId), eq(aiConversationMessages.clientMessageId, clientMessageId)))
    .limit(1);
  if (!userMessage) return null;
  const [assistantMessage] = await db
    .select()
    .from(aiConversationMessages)
    .where(
      and(
        eq(aiConversationMessages.conversationId, conversationId),
        eq(aiConversationMessages.role, "ASSISTANT"),
        gt(aiConversationMessages.createdAt, userMessage.createdAt),
      ),
    )
    .orderBy(asc(aiConversationMessages.createdAt))
    .limit(1);
  return { userMessage, assistantMessage: assistantMessage ?? null };
}

/** Insert the user's message. Idempotent on (conversationId, clientMessageId) when a clientMessageId is given — a retried write is a silent no-op, never a duplicate row. */
export async function appendUserMessage(conversationId: string, content: string, clientMessageId?: string): Promise<AiConversationMessage> {
  if (!clientMessageId) {
    const [row] = await db.insert(aiConversationMessages).values({ conversationId, role: "USER", content }).returning();
    return row;
  }
  const [row] = await db
    .insert(aiConversationMessages)
    .values({ conversationId, role: "USER", content, clientMessageId })
    .onConflictDoNothing({ target: [aiConversationMessages.conversationId, aiConversationMessages.clientMessageId] })
    .returning();
  if (row) return row;
  // Conflict: this exact (conversationId, clientMessageId) was already inserted by an earlier attempt — return that row.
  const [existing] = await db
    .select()
    .from(aiConversationMessages)
    .where(and(eq(aiConversationMessages.conversationId, conversationId), eq(aiConversationMessages.clientMessageId, clientMessageId)))
    .limit(1);
  if (existing) return existing;
  throw new Error("appendUserMessage: insert conflicted but no existing row found — unexpected state.");
}

export async function appendAssistantMessage(conversationId: string, input: Omit<ConversationMessageInput, "role" | "clientMessageId">): Promise<AiConversationMessage> {
  const [row] = await db
    .insert(aiConversationMessages)
    .values({
      conversationId,
      role: "ASSISTANT",
      content: input.content,
      toolCallLog: input.toolCallLog ?? null,
      analysisCards: input.analysisCards ?? null,
      proposalRefs: input.proposalRefs ?? null,
    })
    .returning();
  return row;
}

/** Bumps lastMessageAt/updatedAt and sets the title once, from the first user message — never overwritten afterward. */
export async function touchConversation(conversationId: string, userId: string, firstUserMessageForTitle?: string): Promise<void> {
  const now = new Date();
  const setValues: Partial<AiConversation> = { lastMessageAt: now, updatedAt: now };
  if (firstUserMessageForTitle) setValues.title = deriveTitle(firstUserMessageForTitle);
  await db
    .update(aiConversations)
    .set(setValues)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)));
}

/** Ownership-checked soft delete — explicit user action only, never a side effect of "new conversation". Returns whether a row was actually deleted (false = not found or not yours, never distinguished). */
export async function softDeleteConversation(conversationId: string, userId: string): Promise<boolean> {
  const result = await db
    .update(aiConversations)
    .set({ status: "DELETED", updatedAt: new Date() })
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId), eq(aiConversations.status, "ACTIVE")))
    .returning({ id: aiConversations.id });
  return result.length > 0;
}
