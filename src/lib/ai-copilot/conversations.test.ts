import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, eqValue, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

/**
 * CONVERSATION OWNERSHIP / IDOR — the mission's own non-negotiable: "Do not
 * allow conversationId alone to grant access." This runs the REAL
 * conversations.ts source (via the repo's fake-drizzle + loadModule
 * harness — see queue.claimItems.test.ts for the same pattern) against a
 * fake db that only ever returns a row when the query's OWN WHERE clause
 * includes the matching user_id — proving ownership is enforced in the
 * SQL itself, not just "fetch by id, then check in app code" (which would
 * be forgettable and is exactly what this test would catch a regression
 * to).
 */

const aiConversations = makeTable("ai_conversations");
const aiConversationMessages = makeTable("ai_conversation_messages");
const schemaStub = { aiConversations, aiConversationMessages };

const OWNER = "user-owner";
const OTHER = "user-other";
const CONVERSATION_ID = "conv-1";

type ConversationsModule = {
  createConversation: (userId: string) => Promise<{ id: string; userId: string }>;
  getOwnedConversation: (conversationId: string, userId: string) => Promise<{ id: string; userId: string } | null>;
  listConversations: (userId: string, limit?: number) => Promise<unknown[]>;
  listMessages: (conversationId: string, userId: string, limit?: number) => Promise<unknown[]>;
  findExistingTurn: (conversationId: string, clientMessageId: string) => Promise<unknown>;
  appendUserMessage: (conversationId: string, content: string, clientMessageId?: string) => Promise<{ id: string }>;
  appendAssistantMessage: (conversationId: string, input: Record<string, unknown>) => Promise<{ id: string }>;
  touchConversation: (conversationId: string, userId: string, firstUserMessageForTitle?: string) => Promise<void>;
  softDeleteConversation: (conversationId: string, userId: string) => Promise<boolean>;
};

/** A row simulating exactly one row owned by OWNER, status ACTIVE — real Postgres semantics: a query whose WHERE doesn't match returns nothing. */
function ownershipAwareRespond(call: QueryCall): unknown {
  if (call.table === "ai_conversations" && call.root === "select") {
    const requestedUserId = eqValue(call, "ai_conversations.userId");
    const requestedId = eqValue(call, "ai_conversations.id");
    if (requestedUserId === OWNER && (requestedId === undefined || requestedId === CONVERSATION_ID)) {
      return [{ id: CONVERSATION_ID, userId: OWNER, status: "ACTIVE", title: null, lastMessageAt: new Date() }];
    }
    return [];
  }
  if (call.table === "ai_conversations" && call.root === "update") {
    const requestedUserId = eqValue(call, "ai_conversations.userId");
    if (requestedUserId === OWNER) return [{ id: CONVERSATION_ID }];
    return [];
  }
  return undefined;
}

async function load(db: FakeDb): Promise<ConversationsModule> {
  const mod = loadModule(new URL("./conversations.ts", import.meta.url), {
    stubs: { "server-only": serverOnlyStub, "drizzle-orm": drizzleStub, "@/db": { db }, "@/db/schema": schemaStub },
  });
  return mod as unknown as ConversationsModule;
}

test("getOwnedConversation: returns the conversation for its OWNER", async () => {
  const db = createFakeDb({ respond: ownershipAwareRespond });
  const mod = await load(db);
  const row = await mod.getOwnedConversation(CONVERSATION_ID, OWNER);
  assert.ok(row);
  assert.equal(row!.id, CONVERSATION_ID);
});

test("IDOR: getOwnedConversation returns null for a NON-OWNER using the exact same conversationId", async () => {
  const db = createFakeDb({ respond: ownershipAwareRespond });
  const mod = await load(db);
  const row = await mod.getOwnedConversation(CONVERSATION_ID, OTHER);
  assert.equal(row, null, "a conversationId alone must never grant access to another user's conversation");
});

test("getOwnedConversation's query includes user_id in the WHERE clause itself (not just an app-level check after fetch-by-id)", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = await load(db);
  await mod.getOwnedConversation(CONVERSATION_ID, OWNER);
  const call = db.calls.find((c) => c.table === "ai_conversations" && c.root === "select");
  assert.ok(call);
  assert.equal(eqValue(call!, "ai_conversations.userId"), OWNER);
  assert.equal(eqValue(call!, "ai_conversations.id"), CONVERSATION_ID);
});

test("IDOR: listMessages for a NON-OWNER's conversationId returns empty AND never queries ai_conversation_messages at all (zero data leakage, not just filtered results)", async () => {
  const db = createFakeDb({ respond: ownershipAwareRespond });
  const mod = await load(db);
  const messages = await mod.listMessages(CONVERSATION_ID, OTHER);
  assert.equal(messages.length, 0);
  assert.equal(db.calls.some((c) => c.table === "ai_conversation_messages"), false, "ownership must be re-checked BEFORE any message row is ever queried");
});

test("listMessages for the OWNER queries ai_conversation_messages scoped to the conversation", async () => {
  const db = createFakeDb({
    respond: (call) => {
      const shared = ownershipAwareRespond(call);
      if (shared !== undefined) return shared;
      if (call.table === "ai_conversation_messages" && call.root === "select") {
        return [{ id: "m1", conversationId: CONVERSATION_ID, role: "USER", content: "hi", createdAt: new Date() }];
      }
      return undefined;
    },
  });
  const mod = await load(db);
  const messages = await mod.listMessages(CONVERSATION_ID, OWNER);
  assert.equal(messages.length, 1);
});

test("IDOR: softDeleteConversation for a NON-OWNER returns false (not found), the row is untouched", async () => {
  const db = createFakeDb({ respond: ownershipAwareRespond });
  const mod = await load(db);
  const deleted = await mod.softDeleteConversation(CONVERSATION_ID, OTHER);
  assert.equal(deleted, false);
});

test("softDeleteConversation for the OWNER returns true, and its UPDATE's WHERE includes user_id", async () => {
  const db = createFakeDb({ respond: ownershipAwareRespond });
  const mod = await load(db);
  const deleted = await mod.softDeleteConversation(CONVERSATION_ID, OWNER);
  assert.equal(deleted, true);
  const call = db.calls.find((c) => c.table === "ai_conversations" && c.root === "update");
  assert.ok(call);
  assert.equal(eqValue(call!, "ai_conversations.userId"), OWNER);
  const setArg = call!.ops.find((o) => o.fn === "set")?.args[0] as Record<string, unknown>;
  assert.equal(setArg.status, "DELETED");
});

test("touchConversation's UPDATE WHERE includes both conversationId and userId — never id alone", async () => {
  const db = createFakeDb({ respond: () => [{}] });
  const mod = await load(db);
  await mod.touchConversation(CONVERSATION_ID, OWNER, "câu hỏi đầu tiên");
  const call = db.calls.find((c) => c.table === "ai_conversations" && c.root === "update");
  assert.ok(call);
  assert.equal(eqValue(call!, "ai_conversations.id"), CONVERSATION_ID);
  assert.equal(eqValue(call!, "ai_conversations.userId"), OWNER);
  const setArg = call!.ops.find((o) => o.fn === "set")?.args[0] as Record<string, unknown>;
  assert.equal(setArg.title, "câu hỏi đầu tiên");
});

test("appendUserMessage stores the clientMessageId for idempotent-replay lookup", async () => {
  const db = createFakeDb({ respond: (call) => (call.root === "insert" ? [{ id: "m1", conversationId: CONVERSATION_ID, role: "USER", content: "hi", clientMessageId: "cmid-1" }] : undefined) });
  const mod = await load(db);
  await mod.appendUserMessage(CONVERSATION_ID, "hi", "cmid-1");
  const call = db.calls.find((c) => c.table === "ai_conversation_messages" && c.root === "insert");
  assert.ok(call);
  const valuesArg = call!.ops.find((o) => o.fn === "values")?.args[0] as Record<string, unknown>;
  assert.equal(valuesArg.clientMessageId, "cmid-1");
  assert.equal(valuesArg.role, "USER");
});

test("appendUserMessage without a clientMessageId inserts without one (no idempotency key needed for anonymous appends)", async () => {
  const db = createFakeDb({ respond: (call) => (call.root === "insert" ? [{ id: "m1" }] : undefined) });
  const mod = await load(db);
  await mod.appendUserMessage(CONVERSATION_ID, "hi");
  const call = db.calls.find((c) => c.table === "ai_conversation_messages" && c.root === "insert");
  const valuesArg = call!.ops.find((o) => o.fn === "values")?.args[0] as Record<string, unknown>;
  assert.equal(valuesArg.clientMessageId, undefined);
});

test("appendAssistantMessage persists safe display metadata only — the shape it accepts has no field for hidden reasoning/raw tool payloads/secrets", async () => {
  const db = createFakeDb({ respond: (call) => (call.root === "insert" ? [{ id: "m2" }] : undefined) });
  const mod = await load(db);
  await mod.appendAssistantMessage(CONVERSATION_ID, {
    content: "câu trả lời",
    toolCallLog: [{ name: "get_current_headcount", ok: true }],
    analysisCards: [],
    proposalRefs: ["prop-1"],
  });
  const call = db.calls.find((c) => c.table === "ai_conversation_messages" && c.root === "insert");
  const valuesArg = call!.ops.find((o) => o.fn === "values")?.args[0] as Record<string, unknown>;
  assert.equal(valuesArg.role, "ASSISTANT");
  assert.deepEqual(Object.keys(valuesArg).sort(), ["analysisCards", "content", "conversationId", "proposalRefs", "role", "toolCallLog"]);
});

test("createConversation inserts a row for exactly the given userId", async () => {
  const db = createFakeDb({ respond: (call) => (call.root === "insert" ? [{ id: "new-conv", userId: OWNER }] : undefined) });
  const mod = await load(db);
  const row = await mod.createConversation(OWNER);
  assert.equal(row.userId, OWNER);
  const call = db.calls.find((c) => c.table === "ai_conversations" && c.root === "insert");
  const valuesArg = call!.ops.find((o) => o.fn === "values")?.args[0] as Record<string, unknown>;
  assert.equal(valuesArg.userId, OWNER);
});
