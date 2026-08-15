import { NextResponse } from "next/server";
import { getAIProvider } from "@/lib/ai/provider";
import { checkAIRateLimit } from "@/lib/ai/rate-limit";
import { AIProviderUnavailableError } from "@/lib/ai/types";
import { analyzeWorkforceOutlook } from "@/lib/ai/workforce-analyst";
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

  let body: Record<string, unknown> = {};
  try {
    if (Number(req.headers.get("content-length") ?? "0") > 0) body = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON không hợp lệ." }, { status: 400 });
  }
  const params = new URLSearchParams();
  for (const key of ["from", "to", "departmentId"] as const) if (typeof body[key] === "string") params.set(key, body[key]);
  const parsed = parseOutlookFilters(params, todayStr());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const outlook = await get_workforce_outlook(guard.session, parsed.filters);
    if (outlook.outOfScope) return NextResponse.json({ error: "Bộ phận nằm ngoài Data Scope." }, { status: 403 });
    const provider = getAIProvider();
    const result = await analyzeWorkforceOutlook(provider, outlook);
    await writeAudit(guard.session, "AI_WORKFORCE_ANALYZE", "workforce_intelligence", {
      provider: result.provider,
      model: result.model,
      operation: "WORKFORCE_ANALYZE",
      estimatedInputTokens: result.estimatedInputTokens,
      durationMs: result.durationMs,
      status: "SUCCESS",
      departmentCount: outlook.scope.departmentCount,
      // No prompt, question, raw records or PII is logged.
    }, "API");
    return NextResponse.json({ analysis: result.data, meta: { provider: result.provider, model: result.model, generatedAt: outlook.generatedAt } });
  } catch (error) {
    if (error instanceof AIProviderUnavailableError) return NextResponse.json({ error: "AI hiện không khả dụng. Số liệu deterministic vẫn hoạt động.", code: "AI_UNAVAILABLE" }, { status: 503 });
    console.error("[workforce-intelligence/ai/analyze]", error);
    await writeAudit(guard.session, "AI_WORKFORCE_ANALYZE", "workforce_intelligence", { operation: "WORKFORCE_ANALYZE", status: "FAILED" }, "API");
    return NextResponse.json({ error: "AI không thể tạo phân tích có cấu trúc. Analytics gốc vẫn khả dụng." }, { status: 502 });
  }
}
