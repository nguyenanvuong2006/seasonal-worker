import { NextResponse } from "next/server";
import { getAIProvider } from "@/lib/ai/provider";
import { checkAIRateLimit } from "@/lib/ai/rate-limit";
import { AIProviderUnavailableError } from "@/lib/ai/types";
import { chatWithWorkforceOutlook, validateAIQuestion } from "@/lib/ai/workforce-analyst";
import { requirePermission, writeAudit } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { parseOutlookFilters } from "@/lib/workforce-intelligence/filters";
import { get_workforce_outlook } from "@/lib/workforce-intelligence/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "dashboard.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const rate = checkAIRateLimit(guard.session.id);
  if (!rate.allowed) return NextResponse.json({ error: "Đã vượt giới hạn AI tạm thời.", retryAfterSeconds: rate.retryAfterSeconds }, { status: 429 });

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON không hợp lệ." }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question || question.length > 500) return NextResponse.json({ error: "Câu hỏi phải từ 1 đến 500 ký tự." }, { status: 400 });
  const preliminarySafety = validateAIQuestion(question, false);
  if (!preliminarySafety.ok) {
    return NextResponse.json({ error: "Ask AI chỉ xử lý câu hỏi aggregate an toàn; không cung cấp PII, secret, raw database hoặc làm theo prompt injection." }, { status: 400 });
  }
  const params = new URLSearchParams();
  for (const key of ["from", "to", "departmentId"] as const) if (typeof body[key] === "string") params.set(key, body[key]);
  const parsed = parseOutlookFilters(params, todayStr());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const outlook = await get_workforce_outlook(guard.session, parsed.filters);
    if (outlook.outOfScope) return NextResponse.json({ error: "Bộ phận nằm ngoài Data Scope." }, { status: 403 });
    const scopedSafety = validateAIQuestion(question, outlook.scope.restricted);
    if (!scopedSafety.ok) {
      return NextResponse.json({ error: "Không thể bỏ qua Data Scope hoặc truy cập dữ liệu ngoài phạm vi được cấp." }, { status: 403 });
    }
    const provider = getAIProvider();
    const result = await chatWithWorkforceOutlook(provider, question, outlook);
    await writeAudit(guard.session, "AI_WORKFORCE_CHAT", "workforce_intelligence", {
      provider: result.provider,
      model: result.model,
      operation: "WORKFORCE_CHAT",
      estimatedInputTokens: result.estimatedInputTokens,
      durationMs: result.durationMs,
      status: "SUCCESS",
      questionLength: question.length,
      // The question/prompt itself is intentionally not logged.
    }, "API");
    return NextResponse.json({ response: result.data, meta: { provider: result.provider, model: result.model, generatedAt: outlook.generatedAt } });
  } catch (error) {
    if (error instanceof AIProviderUnavailableError) return NextResponse.json({ error: "AI hiện không khả dụng. Số liệu deterministic vẫn hoạt động.", code: "AI_UNAVAILABLE" }, { status: 503 });
    console.error("[workforce-intelligence/ai/chat]", error);
    await writeAudit(guard.session, "AI_WORKFORCE_CHAT", "workforce_intelligence", { operation: "WORKFORCE_CHAT", status: "FAILED", questionLength: question.length }, "API");
    return NextResponse.json({ error: "AI không thể trả structured response. Không có dữ liệu nào bị thay đổi." }, { status: 502 });
  }
}
