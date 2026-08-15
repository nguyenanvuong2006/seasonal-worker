const windows = new Map<string, { startedAt: number; count: number }>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;

/** Best-effort per-instance limiter; no Redis is introduced for this internal app. */
export function checkAIRateLimit(userId: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  const current = windows.get(userId);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    windows.set(userId, { startedAt: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= MAX_REQUESTS) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - current.startedAt)) / 1000)) };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}
