/**
 * AI COPILOT — action execution re-check gate (Phase 3 "Safe Action
 * Copilot"). Pure (no "server-only", no DB) — the single choke point the
 * execute route must pass through before calling an ActionDefinition's
 * execute(). Every check re-evaluates LIVE state (the confirming
 * session's CURRENT permission/Data Scope, the CURRENT time) — nothing
 * here trusts a value captured back at prepare time except the proposal's
 * own identity (id/createdBy/idempotencyKey), which is exactly what makes
 * a proposal tamper-proof: the browser cannot submit a modified payload at
 * execute time because execute() never accepts a payload from the client
 * at all — see the API route, which passes only `proposalId`.
 */

export type ProposalStatus = "PENDING" | "CONFIRMED" | "EXECUTED" | "FAILED" | "EXPIRED" | "CANCELLED";

export type ProposalForGuard = {
  id: string;
  status: ProposalStatus;
  createdBy: string;
  requiredPermission: string;
  departmentId: string | null;
  expiresAt: string; // ISO timestamp
  executionResult: Record<string, unknown> | null;
};

export type ExecutingUser = {
  id: string;
  hasRequiredPermission: boolean;
  /** null = GLOBAL (unrestricted); [] = no department; [ids] = exactly those — same 3-way convention as data-scope.ts. */
  scope: string[] | null;
};

export type ExecutionGuardResult =
  | { outcome: "EXECUTE" }
  | { outcome: "ALREADY_EXECUTED"; resultRef: Record<string, unknown> }
  | { outcome: "BLOCKED"; code: "NOT_FOUND" | "WRONG_USER" | "EXPIRED" | "WRONG_STATUS" | "FORBIDDEN" | "OUT_OF_SCOPE"; message: string };

function scopeAllows(scope: string[] | null, departmentId: string | null): boolean {
  if (scope === null) return true;
  if (!departmentId) return false;
  return scope.includes(departmentId);
}

/**
 * `proposal` may be null (not found). `nowIso` is injected (never read from
 * the system clock in here) so expiry logic is deterministic and testable.
 */
export function checkProposalExecutable(proposal: ProposalForGuard | null, user: ExecutingUser, nowIso: string): ExecutionGuardResult {
  if (!proposal) return { outcome: "BLOCKED", code: "NOT_FOUND", message: "Không tìm thấy đề xuất hành động này." };

  // Idempotent double-execute: a proposal already EXECUTED short-circuits
  // to the SAME stored result — no re-validation, no second write, no
  // second audit "executed" event needed.
  if (proposal.status === "EXECUTED") {
    return { outcome: "ALREADY_EXECUTED", resultRef: proposal.executionResult ?? {} };
  }

  if (proposal.status !== "PENDING") {
    const labels: Record<string, string> = { CONFIRMED: "đang được xử lý", FAILED: "đã thất bại trước đó", EXPIRED: "đã hết hạn", CANCELLED: "đã bị hủy" };
    return { outcome: "BLOCKED", code: "WRONG_STATUS", message: `Đề xuất này ${labels[proposal.status] ?? "không còn hợp lệ"}.` };
  }

  // Wrong user: only the session that PREPARED a proposal may confirm it —
  // a proposal is not a shared/transferable authorization token.
  if (proposal.createdBy !== user.id) {
    return { outcome: "BLOCKED", code: "WRONG_USER", message: "Chỉ người đã tạo đề xuất này mới có thể xác nhận thực hiện." };
  }

  if (proposal.expiresAt <= nowIso) {
    return { outcome: "BLOCKED", code: "EXPIRED", message: "Đề xuất đã hết hạn — vui lòng yêu cầu lại." };
  }

  // Permission and Data Scope are re-checked against LIVE state, never
  // against anything captured at prepare time — a role change, a Data
  // Scope change, or a revoked permission between prepare and confirm
  // must block execution even though the proposal itself hasn't changed.
  if (!user.hasRequiredPermission) {
    return { outcome: "BLOCKED", code: "FORBIDDEN", message: "Bạn không còn quyền thực hiện hành động này." };
  }

  if (!scopeAllows(user.scope, proposal.departmentId)) {
    return { outcome: "BLOCKED", code: "OUT_OF_SCOPE", message: "Bộ phận của đề xuất này nằm ngoài Data Scope hiện tại của bạn." };
  }

  return { outcome: "EXECUTE" };
}
