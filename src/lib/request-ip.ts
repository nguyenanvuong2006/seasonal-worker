/**
 * Trusted-platform client IP extraction — same logic already used by
 * src/app/api/auth/login/route.ts's brute-force guard. Vercel's edge sets
 * (and, per Vercel's own docs, is the authoritative source for) `x-real-ip`
 * / prepends the real client to `x-forwarded-for` before a request reaches
 * this function — arbitrary client-supplied header values do not bypass
 * that. This does NOT attempt to parse/trust a full forwarded-for chain
 * (a spoofable list past the platform-set first hop); it only ever reads
 * the first (platform-set) entry.
 */
export function trustedClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
