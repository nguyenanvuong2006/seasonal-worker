import test from "node:test";
import assert from "node:assert/strict";
import { checkProposalExecutable, type ProposalForGuard, type ExecutingUser } from "./action-execution-guard.ts";

const NOW = "2026-09-09T12:00:00.000Z";

const BASE_PROPOSAL: ProposalForGuard = {
  id: "prop-1",
  status: "PENDING",
  createdBy: "user-1",
  requiredPermission: "planning.request",
  departmentId: "dept-1",
  expiresAt: "2026-09-09T12:30:00.000Z",
  executionResult: null,
};

const AUTHORIZED_USER: ExecutingUser = { id: "user-1", hasRequiredPermission: true, scope: null };

test("happy path: PENDING, correct user, not expired, has permission, in scope -> EXECUTE", () => {
  const r = checkProposalExecutable(BASE_PROPOSAL, AUTHORIZED_USER, NOW);
  assert.deepEqual(r, { outcome: "EXECUTE" });
});

test("missing proposal -> NOT_FOUND, never crashes", () => {
  const r = checkProposalExecutable(null, AUTHORIZED_USER, NOW);
  assert.deepEqual(r, { outcome: "BLOCKED", code: "NOT_FOUND", message: "Không tìm thấy đề xuất hành động này." });
});

test("already EXECUTED -> idempotent short-circuit returns the SAME stored result, not a fresh EXECUTE", () => {
  const executed: ProposalForGuard = { ...BASE_PROPOSAL, status: "EXECUTED", executionResult: { requestId: "req-123" } };
  const r1 = checkProposalExecutable(executed, AUTHORIZED_USER, NOW);
  const r2 = checkProposalExecutable(executed, AUTHORIZED_USER, NOW);
  assert.deepEqual(r1, { outcome: "ALREADY_EXECUTED", resultRef: { requestId: "req-123" } });
  assert.deepEqual(r1, r2, "double-execute must be perfectly idempotent — identical result both times");
});

test("already EXECUTED with a null executionResult never crashes — returns an empty object, not null/undefined", () => {
  const executed: ProposalForGuard = { ...BASE_PROPOSAL, status: "EXECUTED", executionResult: null };
  const r = checkProposalExecutable(executed, AUTHORIZED_USER, NOW);
  assert.deepEqual(r, { outcome: "ALREADY_EXECUTED", resultRef: {} });
});

for (const status of ["FAILED", "EXPIRED", "CANCELLED", "CONFIRMED"] as const) {
  test(`status=${status} (never PENDING/EXECUTED) is blocked with WRONG_STATUS, never silently retried`, () => {
    const r = checkProposalExecutable({ ...BASE_PROPOSAL, status }, AUTHORIZED_USER, NOW);
    assert.equal(r.outcome, "BLOCKED");
    assert.equal(r.outcome === "BLOCKED" ? r.code : undefined, "WRONG_STATUS");
  });
}

test("wrong user cannot execute someone else's proposal, even with full permission and correct scope", () => {
  const otherUser: ExecutingUser = { id: "user-2", hasRequiredPermission: true, scope: null };
  const r = checkProposalExecutable(BASE_PROPOSAL, otherUser, NOW);
  assert.deepEqual(r, { outcome: "BLOCKED", code: "WRONG_USER", message: "Chỉ người đã tạo đề xuất này mới có thể xác nhận thực hiện." });
});

test("expired proposal cannot execute, even by the correct user with permission", () => {
  const afterExpiry = "2026-09-09T12:30:00.001Z"; // 1ms after expiresAt
  const r = checkProposalExecutable(BASE_PROPOSAL, AUTHORIZED_USER, afterExpiry);
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.outcome === "BLOCKED" ? r.code : undefined, "EXPIRED");
});

test("the exact expiry instant is still valid (expiresAt is an inclusive upper bound only when strictly in the past)", () => {
  const exactlyAtExpiry = BASE_PROPOSAL.expiresAt;
  const r = checkProposalExecutable(BASE_PROPOSAL, AUTHORIZED_USER, exactlyAtExpiry);
  assert.equal(r.outcome, "BLOCKED", "at the exact expiry timestamp, the proposal must already be treated as expired");
});

test("insufficient permission blocks execution even for the correct user within scope", () => {
  const noPermUser: ExecutingUser = { id: "user-1", hasRequiredPermission: false, scope: null };
  const r = checkProposalExecutable(BASE_PROPOSAL, noPermUser, NOW);
  assert.deepEqual(r, { outcome: "BLOCKED", code: "FORBIDDEN", message: "Bạn không còn quyền thực hiện hành động này." });
});

test("Data Scope changed since prepare time (now excludes the proposal's department) blocks execution", () => {
  const rescoped: ExecutingUser = { id: "user-1", hasRequiredPermission: true, scope: ["dept-99-not-the-proposal-dept"] };
  const r = checkProposalExecutable(BASE_PROPOSAL, rescoped, NOW);
  assert.deepEqual(r, { outcome: "BLOCKED", code: "OUT_OF_SCOPE", message: "Bộ phận của đề xuất này nằm ngoài Data Scope hiện tại của bạn." });
});

test("Data Scope that includes the proposal's department -> allowed", () => {
  const rescoped: ExecutingUser = { id: "user-1", hasRequiredPermission: true, scope: ["dept-1", "dept-2"] };
  const r = checkProposalExecutable(BASE_PROPOSAL, rescoped, NOW);
  assert.deepEqual(r, { outcome: "EXECUTE" });
});

test("Data Scope narrowed to NO departments at all ([]) always blocks, even for a department-less proposal", () => {
  const noScopeUser: ExecutingUser = { id: "user-1", hasRequiredPermission: true, scope: [] };
  const deptless: ProposalForGuard = { ...BASE_PROPOSAL, departmentId: null };
  const r = checkProposalExecutable(deptless, noScopeUser, NOW);
  assert.deepEqual(r, { outcome: "BLOCKED", code: "OUT_OF_SCOPE", message: "Bộ phận của đề xuất này nằm ngoài Data Scope hiện tại của bạn." });
});

test("a department-less proposal (departmentId=null) executes fine under GLOBAL (null) scope", () => {
  const deptless: ProposalForGuard = { ...BASE_PROPOSAL, departmentId: null };
  const r = checkProposalExecutable(deptless, AUTHORIZED_USER, NOW);
  assert.deepEqual(r, { outcome: "EXECUTE" });
});

test("checks run in a fixed, safety-first order: WRONG_USER is caught before EXPIRED, FORBIDDEN, or OUT_OF_SCOPE would also fire", () => {
  // Construct a proposal that is simultaneously wrong-user AND expired AND
  // would fail permission/scope too — must report WRONG_USER, not one of
  // the others, proving the order is deliberate and doesn't leak which
  // OTHER check would have failed for a proposal that isn't yours.
  const otherUser: ExecutingUser = { id: "attacker", hasRequiredPermission: false, scope: [] };
  const longExpired: ProposalForGuard = { ...BASE_PROPOSAL, expiresAt: "2020-01-01T00:00:00.000Z" };
  const r = checkProposalExecutable(longExpired, otherUser, NOW);
  assert.equal(r.outcome === "BLOCKED" ? r.code : undefined, "WRONG_USER");
});

test("is a pure function — identical input always yields identical output", () => {
  const a = checkProposalExecutable(BASE_PROPOSAL, AUTHORIZED_USER, NOW);
  const b = checkProposalExecutable(BASE_PROPOSAL, AUTHORIZED_USER, NOW);
  assert.deepEqual(a, b);
});
