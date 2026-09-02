/**
 * POST /api/candidate-consent/lookup
 *
 * STEP 1 of the public candidate flow — "TRA CỨU HỒ SƠ". CCCD + phone only
 * (zero-cost: no SMS/paid OTP). On success, issues an opaque access-session
 * cookie (see session-store.ts) instead of asking for CCCD/phone again on
 * every later request.
 *
 * Anti-enumeration: reuses the EXISTING verifyLookupIdentity() (same
 * generic error for "wrong CCCD" vs "wrong phone" as the pre-existing
 * /lookup flow) and adds durable, Postgres-backed rate limiting (never an
 * in-memory map — this is a public unauthenticated endpoint, and Vercel
 * runs many stateless instances) with an increasing, never-permanent
 * lockout. CCCD/phone are read from the POST body only — never a query
 * string, never logged raw.
 */

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, identityLookupAttempts } from "@/db/schema";
import { verifyLookupIdentity } from "@/lib/lookup-identity";
import { normalizePersonName } from "@/lib/person-name";
import { evaluateAttempt, resetOnSuccess, type LimiterRow } from "@/lib/candidate-consent/rate-limiter";
import { identityLimiterKey, ipLimiterKey, cccdHmac } from "@/lib/candidate-consent/identity";
import { issueAccessSessionCookie } from "@/lib/candidate-consent/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function consentSecret(): string {
  const base = process.env.AUTH_SECRET;
  if (!base) throw new Error("AUTH_SECRET is not configured");
  return `candidate-consent:v1:${base}`;
}

function requestIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

async function readLimiterRow(key: string): Promise<LimiterRow | null> {
  const [row] = await db.select().from(identityLookupAttempts).where(eq(identityLookupAttempts.limiterKey, key)).limit(1);
  if (!row) return null;
  return {
    attemptCount: row.attemptCount,
    windowStartMs: row.windowStartAt.getTime(),
    lockedUntilMs: row.lockedUntil ? row.lockedUntil.getTime() : null,
    lockoutStrikes: row.lockoutStrikes,
  };
}

async function writeLimiterRow(key: string, next: LimiterRow): Promise<void> {
  await db
    .insert(identityLookupAttempts)
    .values({
      limiterKey: key,
      attemptCount: next.attemptCount,
      windowStartAt: new Date(next.windowStartMs),
      lockedUntil: next.lockedUntilMs ? new Date(next.lockedUntilMs) : null,
      lockoutStrikes: next.lockoutStrikes,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: identityLookupAttempts.limiterKey,
      set: {
        attemptCount: next.attemptCount,
        windowStartAt: new Date(next.windowStartMs),
        lockedUntil: next.lockedUntilMs ? new Date(next.lockedUntilMs) : null,
        lockoutStrikes: next.lockoutStrikes,
        updatedAt: new Date(),
      },
    });
}

const GENERIC_DENY = { error: "Thông tin không chính xác hoặc không có hồ sơ có thể truy cập." };

export async function POST(request: Request) {
  const secret = consentSecret();
  const ip = requestIp(request);
  const now = Date.now();

  let body: { cccd?: unknown; phone?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  }

  const rawCccd = String(body.cccd ?? "");
  const rawPhone = String(body.phone ?? "");

  // Rate-limit BOTH by IP and by the identity being guessed — either bucket
  // exhausting denies the request, so brute-forcing one CCCD from many IPs
  // or many CCCDs from one IP are both throttled.
  const ipKey = ipLimiterKey(ip, secret);
  const identityKey = identityLimiterKey(rawCccd, rawPhone, secret);

  const [ipRow, identityRow] = await Promise.all([readLimiterRow(ipKey), readLimiterRow(identityKey)]);
  const ipDecision = evaluateAttempt(ipRow, now);
  const identityDecision = evaluateAttempt(identityRow, now);

  if (!ipDecision.allowed || !identityDecision.allowed) {
    await Promise.all([writeLimiterRow(ipKey, ipDecision.nextRow), writeLimiterRow(identityKey, identityDecision.nextRow)]);
    const retryAfterSeconds = Math.max(
      !ipDecision.allowed ? ipDecision.retryAfterSeconds : 0,
      !identityDecision.allowed ? identityDecision.retryAfterSeconds : 0,
    );
    return NextResponse.json(
      { error: "Bạn đã thử quá nhiều lần. Vui lòng thử lại sau." },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }
  await Promise.all([writeLimiterRow(ipKey, ipDecision.nextRow), writeLimiterRow(identityKey, identityDecision.nextRow)]);

  const identity = await verifyLookupIdentity(rawCccd, rawPhone);
  if (!identity.ok) {
    // Always the SAME generic message regardless of which check failed —
    // never reveal whether CCCD or phone was the mismatch.
    return NextResponse.json(GENERIC_DENY, { status: 404 });
  }

  // Success clears both buckets so legitimate repeat use is never throttled.
  await Promise.all([
    writeLimiterRow(ipKey, resetOnSuccess(now)),
    writeLimiterRow(identityKey, resetOnSuccess(now)),
  ]);

  const applications = await db
    .select({ id: dailyApplications.id })
    .from(dailyApplications)
    .where(and(eq(dailyApplications.cccd, identity.cccd), isNull(dailyApplications.deletedAt)));
  const scopedApplicationIds = applications.map((a) => a.id);

  if (scopedApplicationIds.length === 0) {
    return NextResponse.json(GENERIC_DENY, { status: 404 });
  }

  const { sessionId } = await issueAccessSessionCookie({
    cccdHmac: cccdHmac(identity.cccd, secret),
    scopedApplicationIds,
    ipAddress: ip === "unknown" ? null : ip,
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json({
    success: true,
    sessionId,
    fullName: normalizePersonName(identity.dwFullName ?? ""),
  });
}
