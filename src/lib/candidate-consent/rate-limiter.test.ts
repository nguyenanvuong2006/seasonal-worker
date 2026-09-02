import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAttempt,
  MAX_ATTEMPTS_PER_WINDOW,
  resetOnSuccess,
  WINDOW_MS,
  type LimiterRow,
} from "./rate-limiter.ts";

test("evaluateAttempt: first-ever attempt (no row) is always allowed", () => {
  const result = evaluateAttempt(null, 1000);
  assert.equal(result.allowed, true);
  assert.equal(result.nextRow.attemptCount, 1);
});

test("evaluateAttempt: allows up to MAX_ATTEMPTS_PER_WINDOW within the window", () => {
  let row: LimiterRow | null = null;
  const now = 0;
  for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++) {
    const result = evaluateAttempt(row, now + i);
    assert.equal(result.allowed, true, `attempt ${i + 1} should be allowed`);
    row = result.nextRow;
  }
});

test("evaluateAttempt: the attempt AFTER the budget is exhausted is denied with a lockout", () => {
  let row: LimiterRow | null = null;
  const now = 0;
  for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++) {
    row = evaluateAttempt(row, now + i).nextRow;
  }
  const denied = evaluateAttempt(row, now + MAX_ATTEMPTS_PER_WINDOW);
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.ok(denied.retryAfterSeconds > 0);
});

test("evaluateAttempt: while locked out, every further attempt is denied (does not reset the lock)", () => {
  let row: LimiterRow | null = null;
  for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++) row = evaluateAttempt(row, i).nextRow;
  const firstDenied = evaluateAttempt(row, MAX_ATTEMPTS_PER_WINDOW);
  row = firstDenied.nextRow;
  const secondDenied = evaluateAttempt(row, MAX_ATTEMPTS_PER_WINDOW + 1);
  assert.equal(secondDenied.allowed, false);
});

test("evaluateAttempt: after the lockout expires, a new attempt is allowed again (never permanent)", () => {
  let row: LimiterRow | null = null;
  for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++) row = evaluateAttempt(row, i).nextRow;
  const denied = evaluateAttempt(row, MAX_ATTEMPTS_PER_WINDOW);
  row = denied.nextRow;
  if (denied.allowed) throw new Error("expected denial");
  const afterLockout = evaluateAttempt(row, MAX_ATTEMPTS_PER_WINDOW + denied.retryAfterSeconds * 1000 + 1);
  assert.equal(afterLockout.allowed, true);
});

test("evaluateAttempt: repeated lockouts escalate (second lockout duration >= first)", () => {
  let row: LimiterRow | null = null;
  for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++) row = evaluateAttempt(row, i).nextRow;
  const firstDenied = evaluateAttempt(row, MAX_ATTEMPTS_PER_WINDOW);
  if (firstDenied.allowed) throw new Error("expected denial");
  row = firstDenied.nextRow;

  // Wait out the first lockout, then immediately exhaust the budget again.
  let t = MAX_ATTEMPTS_PER_WINDOW + firstDenied.retryAfterSeconds * 1000 + 1;
  for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++) {
    row = evaluateAttempt(row, t + i).nextRow;
  }
  const secondDenied = evaluateAttempt(row, t + MAX_ATTEMPTS_PER_WINDOW);
  if (secondDenied.allowed) throw new Error("expected second denial");
  assert.ok(secondDenied.retryAfterSeconds >= firstDenied.retryAfterSeconds, "lockout must escalate, never shrink");
});

test("evaluateAttempt: lockout duration is capped (never grows unbounded)", () => {
  let row: LimiterRow | null = null;
  let t = 0;
  let lastRetryAfter = 0;
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++) row = evaluateAttempt(row, t + i).nextRow;
    const denied = evaluateAttempt(row, t + MAX_ATTEMPTS_PER_WINDOW);
    if (denied.allowed) throw new Error("expected denial");
    row = denied.nextRow;
    lastRetryAfter = denied.retryAfterSeconds;
    t += MAX_ATTEMPTS_PER_WINDOW + denied.retryAfterSeconds * 1000 + 1;
  }
  assert.ok(lastRetryAfter <= 30 * 60, "lockout must never exceed the 30-minute cap");
});

test("evaluateAttempt: window resets naturally after WINDOW_MS with no lockout ever triggered", () => {
  let row: LimiterRow | null = evaluateAttempt(null, 0).nextRow;
  const afterWindow = evaluateAttempt(row, WINDOW_MS + 1);
  assert.equal(afterWindow.allowed, true);
  assert.equal(afterWindow.nextRow.attemptCount, 1);
});

test("resetOnSuccess: a successful lookup clears the attempt count and any lockout", () => {
  const reset = resetOnSuccess(500);
  assert.equal(reset.attemptCount, 0);
  assert.equal(reset.lockedUntilMs, null);
  assert.equal(reset.windowStartMs, 500);
});

test("evaluateAttempt: after resetOnSuccess, the candidate again gets the full attempt budget", () => {
  let row: LimiterRow | null = null;
  for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW - 1; i++) row = evaluateAttempt(row, i).nextRow;
  row = resetOnSuccess(MAX_ATTEMPTS_PER_WINDOW);
  for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++) {
    const result = evaluateAttempt(row, MAX_ATTEMPTS_PER_WINDOW + i);
    assert.equal(result.allowed, true);
    row = result.nextRow;
  }
});
