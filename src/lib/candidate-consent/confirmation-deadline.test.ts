import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDeadlineFromDays,
  resolveConfirmationDeadline,
  parseDeadlinePolicyFromBody,
  formatDeadline,
  formatRemainingTime,
  DEFAULT_CONFIRMATION_WINDOW_DAYS,
} from "./confirmation-deadline.ts";

test("default window is 3 days", () => {
  assert.equal(DEFAULT_CONFIRMATION_WINDOW_DAYS, 3);
});

test("computeDeadlineFromDays: issuedAt + N days, exact millisecond arithmetic (Asia/Ho_Chi_Minh has no DST)", () => {
  const issuedAt = new Date("2026-09-10T10:00:00.000Z");
  const deadline = computeDeadlineFromDays(issuedAt, 3);
  assert.equal(deadline.toISOString(), "2026-09-13T10:00:00.000Z");
});

test("resolveConfirmationDeadline: DAYS policy computes issuedAt+N", () => {
  const issuedAt = new Date("2026-09-10T10:00:00.000Z");
  const result = resolveConfirmationDeadline({ kind: "DAYS", days: 7 }, issuedAt);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.deadlineAt.toISOString(), "2026-09-17T10:00:00.000Z");
});

test("resolveConfirmationDeadline: DAYS policy rejects out-of-range values", () => {
  const issuedAt = new Date("2026-09-10T10:00:00.000Z");
  assert.equal(resolveConfirmationDeadline({ kind: "DAYS", days: 0 }, issuedAt).ok, false);
  assert.equal(resolveConfirmationDeadline({ kind: "DAYS", days: -1 }, issuedAt).ok, false);
  assert.equal(resolveConfirmationDeadline({ kind: "DAYS", days: 1.5 }, issuedAt).ok, false);
  assert.equal(resolveConfirmationDeadline({ kind: "DAYS", days: 400 }, issuedAt).ok, false);
});

test("resolveConfirmationDeadline: ABSOLUTE policy accepts a future instant", () => {
  const issuedAt = new Date("2026-09-10T10:00:00.000Z");
  const at = new Date("2026-09-13T17:00:00.000Z");
  const result = resolveConfirmationDeadline({ kind: "ABSOLUTE", at }, issuedAt);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.deadlineAt.getTime(), at.getTime());
});

test("resolveConfirmationDeadline: ABSOLUTE policy rejects a deadline at or before issuedAt", () => {
  const issuedAt = new Date("2026-09-10T10:00:00.000Z");
  assert.equal(resolveConfirmationDeadline({ kind: "ABSOLUTE", at: issuedAt }, issuedAt).ok, false);
  assert.equal(resolveConfirmationDeadline({ kind: "ABSOLUTE", at: new Date("2026-09-09T00:00:00.000Z") }, issuedAt).ok, false);
});

test("resolveConfirmationDeadline: ABSOLUTE policy rejects an invalid date", () => {
  const issuedAt = new Date("2026-09-10T10:00:00.000Z");
  const result = resolveConfirmationDeadline({ kind: "ABSOLUTE", at: new Date("not-a-date") }, issuedAt);
  assert.equal(result.ok, false);
});

test("parseDeadlinePolicyFromBody: prefers deadlineAt over deadlineDays when both present", () => {
  const policy = parseDeadlinePolicyFromBody({ deadlineAt: "2026-09-13T17:00:00.000Z", deadlineDays: 7 });
  assert.deepEqual(policy, { kind: "ABSOLUTE", at: new Date("2026-09-13T17:00:00.000Z") });
});

test("parseDeadlinePolicyFromBody: falls back to deadlineDays", () => {
  const policy = parseDeadlinePolicyFromBody({ deadlineDays: 5 });
  assert.deepEqual(policy, { kind: "DAYS", days: 5 });
});

test("parseDeadlinePolicyFromBody: defaults to the 3-day window when neither is present", () => {
  const policy = parseDeadlinePolicyFromBody({});
  assert.deepEqual(policy, { kind: "DAYS", days: DEFAULT_CONFIRMATION_WINDOW_DAYS });
});

test("formatDeadline: renders Asia/Ho_Chi_Minh date/time without seconds", () => {
  // 2026-09-13T10:00:00Z = 17:00 in UTC+7.
  assert.equal(formatDeadline("2026-09-13T10:00:00.000Z"), "13/09/2026 17:00");
});

test("formatDeadline: null/invalid -> em dash", () => {
  assert.equal(formatDeadline(null), "—");
  assert.equal(formatDeadline("not-a-date"), "—");
});

test("formatRemainingTime: informational only, never authoritative — days/hours/minutes granularity", () => {
  const now = new Date("2026-09-10T10:00:00.000Z");
  assert.equal(formatRemainingTime("2026-09-13T10:00:00.000Z", now), "Còn 3 ngày");
  assert.equal(formatRemainingTime("2026-09-10T15:00:00.000Z", now), "Còn 5 giờ");
  assert.equal(formatRemainingTime("2026-09-10T10:05:00.000Z", now), "Còn 5 phút");
});

test("formatRemainingTime: already past -> null (no misleading 'Còn -1 ngày')", () => {
  const now = new Date("2026-09-13T10:00:01.000Z");
  assert.equal(formatRemainingTime("2026-09-13T10:00:00.000Z", now), null);
});

test("formatRemainingTime: null deadline -> null", () => {
  assert.equal(formatRemainingTime(null, new Date()), null);
});
