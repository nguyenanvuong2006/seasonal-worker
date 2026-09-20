/**
 * Pure utilities extracted from scheduler.ts so they can be
 * imported and tested outside a Next.js server context
 * (scheduler.ts has `import "server-only"` which prevents test imports).
 *
 * NO "server-only" guard here — these are pure functions.
 */

/**
 * Sanitise a thrown value into a short, loggable string.
 * Rules:
 *   - No stack trace (contains source paths; irrelevant to operators).
 *   - Strips credential-shaped substrings (conservatively removes anything
 *     after "secret", "token", "password", "Bearer" in the message).
 *   - Truncated to 200 chars so it fits comfortably in audit_log details.
 */
export function sanitizeJobError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const scrubbed = raw.replace(/(?:secret|token|password|bearer)[^\s]*/gi, "[REDACTED]");
  return scrubbed.slice(0, 200);
}

/**
 * Compute hours since last OK run from the scheduled_jobs row values.
 * Mirrors the SQL CASE expression in /api/admin/system-stats/route.ts.
 * Returns null when the job has never succeeded or last run was a failure.
 */
export function hoursSinceLastOk(lastStatus: string | null, lastRunAt: Date | null): number | null {
  if (lastStatus === "OK" && lastRunAt !== null) {
    return Math.round((Date.now() - lastRunAt.getTime()) / 3600_000 * 10) / 10;
  }
  return null;
}
