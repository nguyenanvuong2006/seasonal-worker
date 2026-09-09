import { NextResponse } from "next/server";
import { checkAIRateLimit } from "@/lib/ai/rate-limit";
import { getUserScope, hasPermission, requirePermission, writeAudit } from "@/lib/auth";
import { getActionRegistry } from "@/lib/ai-copilot/action-registry";
import { createProposal } from "@/lib/ai-copilot/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Copilot — Safe Action Copilot, STEP 1/2. Resolves and validates an
 * action's args into a canonical, immutable payload and PERSISTS a
 * proposal — this endpoint NEVER writes to any business table (see
 * ActionDefinition.validate() in action-types.ts). The proposal is only
 * ever turned into a real write by a human explicitly confirming it via
 * POST /api/ai-copilot/action/[proposalId]/execute — never by this route,
 * never by the model itself.
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "ai_copilot.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rate = checkAIRateLimit(guard.session.id);
  if (!rate.allowed) return NextResponse.json({ error: "Đã vượt giới hạn tạm thời, vui lòng thử lại sau.", retryAfterSeconds: rate.retryAfterSeconds }, { status: 429 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON không hợp lệ." }, { status: 400 });
  }
  const actionName = typeof body.action === "string" ? body.action : "";
  const actionDef = getActionRegistry().get(actionName);
  if (!actionDef) return NextResponse.json({ error: "Hành động không tồn tại trong danh sách được phép." }, { status: 400 });

  const allowed = await hasPermission(guard.session.role, actionDef.requiredPermission);
  if (!allowed) return NextResponse.json({ error: "Bạn không có quyền thực hiện hành động này." }, { status: 403 });

  let args: unknown;
  try {
    args = actionDef.parseArgs(body.args);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Tham số không hợp lệ." }, { status: 400 });
  }

  const validation = await actionDef.validate({ session: guard.session }, args);
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

  const scope = await getUserScope(guard.session);
  const proposal = await createProposal({
    action: actionDef.name,
    payload: validation.payload as Record<string, unknown>,
    humanReadablePreview: actionDef.buildPreview(validation.payload),
    departmentId: validation.departmentId,
    requiredPermission: actionDef.requiredPermission,
    dataScopeSnapshot: scope,
    createdBy: guard.session.id,
  });

  await writeAudit(
    guard.session,
    "AI_ACTION_PROPOSED",
    "ai_copilot_action",
    { proposalId: proposal.id, action: actionDef.name, departmentId: validation.departmentId },
    "API",
  );

  return NextResponse.json({
    proposalId: proposal.id,
    action: actionDef.name,
    payload: validation.payload,
    humanReadablePreview: proposal.humanReadablePreview,
    expiresAt: proposal.expiresAt.toISOString(),
    requiredPermission: actionDef.requiredPermission,
  });
}
