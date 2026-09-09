import { NextResponse } from "next/server";
import { checkAIRateLimit } from "@/lib/ai/rate-limit";
import { validateAIQuestion } from "@/lib/ai/workforce-analyst";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { runCopilotTurn } from "@/lib/ai-copilot/orchestrator";
import { ToolCallingProviderError } from "@/lib/ai-copilot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Admin Copilot — multi-turn, tool-calling chat endpoint. Reuses the
 * exact same defensive posture as the existing single-shot Workforce
 * Intelligence chat route (src/app/api/workforce-intelligence/ai/chat/route.ts):
 * requirePermission -> per-user rate limit -> input safety pre-check ->
 * privacy-safe audit logging (never the raw question/prompt). The actual
 * data access happens INSIDE runCopilotTurn()'s tool dispatch, which
 * re-resolves RBAC/Data Scope from `guard.session` on every single tool
 * call — this route never passes a scope or authorization decision in.
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "ai_copilot.view");
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

  const startedAt = Date.now();
  try {
    const result = await runCopilotTurn(guard.session, question, body.history);
    await writeAudit(
      guard.session,
      "AI_COPILOT_CHAT",
      "ai_copilot",
      {
        operation: "COPILOT_CHAT",
        status: "SUCCESS",
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
      reply: result.reply,
      toolCallLog: result.toolCallLog.map((t) => ({ name: t.name, ok: t.ok, truncated: t.truncated })),
      proposals: result.proposals,
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
      { operation: "COPILOT_CHAT", status: "FAILED", questionLength: question.length, durationMs: Date.now() - startedAt },
      "API",
    );
    return NextResponse.json({ error: "Trợ lý AI không thể trả lời lúc này. Không có dữ liệu nào bị thay đổi." }, { status: 502 });
  }
}
