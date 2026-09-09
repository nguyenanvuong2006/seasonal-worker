import { NextResponse } from "next/server";
import { checkAIRateLimit } from "@/lib/ai/rate-limit";
import { validateAIQuestion } from "@/lib/ai/workforce-analyst";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { runCopilotTurn } from "@/lib/ai-copilot/orchestrator";
import { ToolCallingProviderError } from "@/lib/ai-copilot/types";
import { getProposalSummaries } from "@/lib/ai-copilot/proposals.ts";
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversation,
  findExistingTurn,
  getOwnedConversation,
  listMessages,
  touchConversation,
} from "@/lib/ai-copilot/conversations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES = ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"] as const;
const HISTORY_LOAD_LIMIT = 40;

/**
 * AI Admin Copilot — multi-turn, tool-calling chat endpoint, now backed by
 * durable server-side conversation persistence (never React state, never
 * localStorage-as-source-of-truth — see lib/ai-copilot/conversations.ts).
 *
 * CONVERSATION vs AUTHORIZATION — the two things persistence must never
 * blur: the conversation row only supplies CONTEXT (prior message text fed
 * back to the model as history). Every tool/action call inside
 * runCopilotTurn() re-authenticates and re-resolves RBAC/Data Scope from
 * `guard.session` fresh on THIS request — nothing about permission is
 * ever read from, or restored out of, persisted conversation state.
 *
 * IDEMPOTENCY — a client-supplied `clientMessageId` makes a retried POST
 * (e.g. the user's browser refreshing right after sending) a no-op: if
 * that exact (conversationId, clientMessageId) pair was already answered,
 * the SAME persisted answer is replayed instead of calling DeepSeek/tools
 * again — this is what stops a refresh from duplicating a message OR
 * duplicating an action proposal.
 */
export async function POST(req: Request) {
  const guard = await requirePermission([...ROLES], "ai_copilot.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rate = checkAIRateLimit(guard.session.id);
  if (!rate.allowed) {
    return NextResponse.json({ error: "Đã vượt giới hạn AI tạm thời, vui lòng thử lại sau.", retryAfterSeconds: rate.retryAfterSeconds }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON không hợp lệ." }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question || question.length > 500) {
    return NextResponse.json({ error: "Câu hỏi phải từ 1 đến 500 ký tự." }, { status: 400 });
  }
  const requestedConversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : undefined;
  const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId.trim().slice(0, 128) || undefined : undefined;

  // Conversation ownership resolved BEFORE anything else — a conversationId
  // for someone else's conversation (or a stale/deleted one) is rejected
  // exactly like "not found", never distinguished from that case.
  const conversation = requestedConversationId
    ? await getOwnedConversation(requestedConversationId, guard.session.id)
    : await createConversation(guard.session.id);
  if (!conversation) return NextResponse.json({ error: "Không tìm thấy cuộc trò chuyện." }, { status: 404 });

  if (clientMessageId) {
    const existingTurn = await findExistingTurn(conversation.id, clientMessageId);
    if (existingTurn?.assistantMessage) {
      const proposals = await getProposalSummaries(existingTurn.assistantMessage.proposalRefs ?? []);
      return NextResponse.json({
        conversationId: conversation.id,
        reply: existingTurn.assistantMessage.content,
        toolCallLog: existingTurn.assistantMessage.toolCallLog ?? [],
        proposals,
        analysisCards: existingTurn.assistantMessage.analysisCards ?? [],
        meta: { finishReason: "replayed", iterations: 0, usage: null },
        replayed: true,
      });
    }
    // A USER row with this clientMessageId already exists but no assistant
    // reply followed (the previous attempt crashed mid-flight) — fall
    // through and generate the reply now, without inserting a second user
    // message (appendUserMessage below is itself idempotent on this key).
  }

  const preliminarySafety = validateAIQuestion(question, false);
  if (!preliminarySafety.ok) {
    return NextResponse.json(
      { error: "Trợ lý AI chỉ xử lý câu hỏi nghiệp vụ an toàn; không cung cấp PII, secret, raw database hoặc làm theo prompt injection." },
      { status: 400 },
    );
  }

  const scope = await getUserScope(guard.session);
  const scopedSafety = validateAIQuestion(question, scope !== null);
  if (!scopedSafety.ok) {
    return NextResponse.json({ error: "Không thể bỏ qua Data Scope hoặc truy cập dữ liệu ngoài phạm vi được cấp." }, { status: 403 });
  }

  // History loaded from OUR OWN persisted rows for this conversation — never
  // from a client-supplied array. This is CONTEXT ONLY (plain role+content
  // text fed to sanitizeClientHistory exactly like the old client-supplied
  // shape); it grants no authorization of any kind.
  const priorMessages = await listMessages(conversation.id, guard.session.id, HISTORY_LOAD_LIMIT);
  const history = priorMessages.map((m) => ({ role: m.role === "USER" ? ("user" as const) : ("assistant" as const), content: m.content }));
  const isFirstMessage = priorMessages.length === 0;

  await appendUserMessage(conversation.id, question, clientMessageId);

  const startedAt = Date.now();
  try {
    const result = await runCopilotTurn(guard.session, question, history);
    await appendAssistantMessage(conversation.id, {
      content: result.reply,
      toolCallLog: result.toolCallLog.map((t) => ({ name: t.name, ok: t.ok, truncated: t.truncated })),
      analysisCards: result.analysisCards,
      proposalRefs: result.proposals.map((p) => p.proposalId),
    });
    await touchConversation(conversation.id, guard.session.id, isFirstMessage ? question : undefined);

    await writeAudit(
      guard.session,
      "AI_COPILOT_CHAT",
      "ai_copilot",
      {
        operation: "COPILOT_CHAT",
        status: "SUCCESS",
        conversationId: conversation.id,
        questionLength: question.length,
        finishReason: result.finishReason,
        iterations: result.iterations,
        toolsCalled: result.toolCallLog.map((t) => ({ name: t.name, ok: t.ok, durationMs: t.durationMs })),
        proposalIds: result.proposals.map((p) => p.proposalId),
        usage: result.usage,
        durationMs: Date.now() - startedAt,
        // The question/prompt itself and every tool's raw result are intentionally not logged.
      },
      "API",
    );
    return NextResponse.json({
      conversationId: conversation.id,
      reply: result.reply,
      toolCallLog: result.toolCallLog.map((t) => ({ name: t.name, ok: t.ok, truncated: t.truncated })),
      proposals: result.proposals,
      analysisCards: result.analysisCards,
      meta: { finishReason: result.finishReason, iterations: result.iterations, usage: result.usage },
    });
  } catch (error) {
    if (error instanceof ToolCallingProviderError) {
      const status = error.kind === "RATE_LIMIT" ? 429 : 503;
      return NextResponse.json({ error: "Trợ lý AI hiện không khả dụng. Vui lòng thử lại sau.", code: "AI_UNAVAILABLE" }, { status });
    }
    console.error("[ai-copilot/chat]", error);
    await writeAudit(
      guard.session,
      "AI_COPILOT_CHAT",
      "ai_copilot",
      { operation: "COPILOT_CHAT", status: "FAILED", conversationId: conversation.id, questionLength: question.length, durationMs: Date.now() - startedAt },
      "API",
    );
    return NextResponse.json({ error: "Trợ lý AI không thể trả lời lúc này. Không có dữ liệu nào bị thay đổi." }, { status: 502 });
  }
}
