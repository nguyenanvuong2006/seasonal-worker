import { NextResponse } from "next/server";
import { getUserScope, hasPermission, requirePermission, writeAudit } from "@/lib/auth";
import { checkProposalExecutable } from "@/lib/ai-copilot/action-execution-guard";
import { getActionRegistry } from "@/lib/ai-copilot/action-registry";
import { getProposalById, markConfirmed, markExecuted, markExpired, markFailed, toGuardShape } from "@/lib/ai-copilot/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BLOCKED_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  WRONG_USER: 403,
  EXPIRED: 409,
  WRONG_STATUS: 409,
  FORBIDDEN: 403,
  OUT_OF_SCOPE: 403,
};

/**
 * AI Copilot — Safe Action Copilot, STEP 2/2. Takes ONLY a proposalId from
 * the client — never a payload — so a browser cannot alter what it is
 * confirming. Re-authenticates, re-checks permission/Data Scope/expiry/
 * idempotency against LIVE state (see action-execution-guard.ts) before
 * calling the one function allowed to actually write: the action's own
 * execute(). The model that proposed this action has no path to reach
 * this route on its own — it is only ever called by the browser after an
 * explicit human click on "Xác nhận thực hiện".
 */
export async function POST(_req: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "ai_copilot.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { proposalId } = await params;
  const row = await getProposalById(proposalId);
  const hasReqPermission = row ? await hasPermission(guard.session.role, row.requiredPermission) : false;
  const scope = await getUserScope(guard.session);

  const result = checkProposalExecutable(
    row ? toGuardShape(row) : null,
    { id: guard.session.id, hasRequiredPermission: hasReqPermission, scope },
    new Date().toISOString(),
  );

  if (result.outcome === "ALREADY_EXECUTED") {
    return NextResponse.json({ resultRef: result.resultRef, idempotent: true });
  }

  if (result.outcome === "BLOCKED") {
    if (result.code === "EXPIRED" && row && row.status === "PENDING") {
      await markExpired(row.id);
      await writeAudit(guard.session, "AI_ACTION_EXPIRED", "ai_copilot_action", { proposalId }, "API");
    }
    return NextResponse.json({ error: result.message }, { status: BLOCKED_STATUS[result.code] ?? 400 });
  }

  // result.outcome === "EXECUTE" — row is guaranteed non-null here (checkProposalExecutable
  // only reaches EXECUTE for a real, PENDING, owned, unexpired, authorized proposal).
  const proposal = row!;
  const actionDef = getActionRegistry().get(proposal.action);
  if (!actionDef) {
    await markFailed(proposal.id, "Hành động không còn tồn tại trong hệ thống.");
    return NextResponse.json({ error: "Hành động không còn tồn tại trong hệ thống." }, { status: 500 });
  }

  await markConfirmed(proposal.id, guard.session.id);
  await writeAudit(guard.session, "AI_ACTION_CONFIRMED", "ai_copilot_action", { proposalId, action: proposal.action }, "API");

  const execution = await actionDef.execute({ session: guard.session }, proposal.payload);
  if (execution.ok) {
    await markExecuted(proposal.id, execution.resultRef);
    await writeAudit(guard.session, "AI_ACTION_EXECUTED", "ai_copilot_action", { proposalId, action: proposal.action, resultRef: execution.resultRef }, "API");
    return NextResponse.json({ resultRef: execution.resultRef });
  }

  await markFailed(proposal.id, execution.message);
  await writeAudit(guard.session, "AI_ACTION_FAILED", "ai_copilot_action", { proposalId, action: proposal.action, code: execution.code }, "API");
  return NextResponse.json({ error: execution.message }, { status: execution.code === "VALIDATION" ? 400 : execution.code === "CONFLICT" ? 409 : 502 });
}
