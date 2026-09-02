/**
 * Pure rate-limit / lockout decision logic for the public identity lookup
 * endpoint (CCCD + phone). DB-agnostic on purpose: the caller reads/writes a
 * `LimiterRow` from Postgres (durable, shared across serverless instances —
 * unlike an in-memory map, this survives cold starts and multiple Vercel
 * instances, at zero additional cost since it's the existing Neon DB), this
 * module only decides what the row's next state should be.
 *
 * Policy: fixed window of WINDOW_MS with MAX_ATTEMPTS_PER_WINDOW allowed.
 * Exceeding it starts a temporary lockout that ESCALATES (exponential,
 * capped) on repeated abuse, but ALWAYS expires — a legitimate candidate is
 * never locked out forever. `lockoutStrikes` persists across window resets
 * so back-to-back abuse keeps escalating; only a successful lookup
 * (`resetOnSuccess`) clears it.
 */

export const WINDOW_MS = 5 * 60_000; // 5 minutes
export const MAX_ATTEMPTS_PER_WINDOW = 5;
const LOCKOUT_BASE_MS = 60_000; // 1 minute
const LOCKOUT_MAX_MS = 30 * 60_000; // 30 minutes cap — never permanent

export interface LimiterRow {
  attemptCount: number;
  windowStartMs: number;
  lockedUntilMs: number | null;
  /** How many times a lockout has been triggered since the last success — drives escalation. */
  lockoutStrikes: number;
}

export type LimiterDecision =
  | { allowed: true; nextRow: LimiterRow }
  | { allowed: false; retryAfterSeconds: number; nextRow: LimiterRow };

function lockoutDurationForStrike(strike: number): number {
  return Math.min(LOCKOUT_MAX_MS, LOCKOUT_BASE_MS * 2 ** Math.max(0, strike - 1));
}

function freshWindow(now: number, lockoutStrikes: number): LimiterRow {
  return { attemptCount: 1, windowStartMs: now, lockedUntilMs: null, lockoutStrikes };
}

/**
 * Decide whether THIS attempt is allowed, given the row's state at `now`.
 * Pure — does not read the clock itself, so it is exhaustively testable.
 */
export function evaluateAttempt(row: LimiterRow | null, now: number): LimiterDecision {
  if (!row) {
    return { allowed: true, nextRow: freshWindow(now, 0) };
  }

  // Still inside an active lockout -> deny, row unchanged.
  if (row.lockedUntilMs !== null && now < row.lockedUntilMs) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((row.lockedUntilMs - now) / 1000)),
      nextRow: row,
    };
  }

  // A lockout that has now elapsed, OR the fixed window has simply run out ->
  // this attempt gets a clean slate (strikes carry over for escalation only).
  const lockoutJustExpired = row.lockedUntilMs !== null && now >= row.lockedUntilMs;
  const windowExpired = now - row.windowStartMs >= WINDOW_MS;
  if (lockoutJustExpired || windowExpired) {
    return { allowed: true, nextRow: freshWindow(now, row.lockoutStrikes) };
  }

  if (row.attemptCount < MAX_ATTEMPTS_PER_WINDOW) {
    return {
      allowed: true,
      nextRow: { ...row, attemptCount: row.attemptCount + 1 },
    };
  }

  // Budget exhausted within the current (non-expired) window -> lock out, escalating on repeat abuse.
  const strikes = row.lockoutStrikes + 1;
  const lockoutMs = lockoutDurationForStrike(strikes);
  const lockedUntilMs = now + lockoutMs;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(lockoutMs / 1000)),
    nextRow: { attemptCount: row.attemptCount + 1, windowStartMs: row.windowStartMs, lockedUntilMs, lockoutStrikes: strikes },
  };
}

/** Record a SUCCESSFUL lookup — resets the window AND clears escalation so legitimate use never accumulates toward a lockout. */
export function resetOnSuccess(now: number): LimiterRow {
  return { attemptCount: 0, windowStartMs: now, lockedUntilMs: null, lockoutStrikes: 0 };
}
