/**
 * Server-side plumbing for the candidate access session cookie. The cookie
 * itself carries ONLY an opaque, cryptographically random token
 * (generateAccessToken in evidence.ts) — never CCCD/phone, never a JWT
 * carrying claims. The server stores just the token's SHA-256 hash
 * (hashAccessToken) in candidate_access_sessions.token_hash, so a leaked DB
 * row can never be replayed as a cookie and a leaked cookie can never be
 * reversed back to CCCD/phone.
 */

import "server-only";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { candidateAccessSessions } from "@/db/schema";
import { generateAccessToken, hashAccessToken } from "./evidence.ts";
import { sessionCanAccessApplication } from "./lifecycle.ts";

export const ACCESS_SESSION_COOKIE = "candidate_access_session";
export const ACCESS_SESSION_TTL_MS = 20 * 60_000; // 20 minutes — short-lived, re-verify to extend

export interface CreateAccessSessionInput {
  cccdHmac: string;
  scopedApplicationIds: string[];
  ipAddress: string | null;
  userAgent: string | null;
}

/** Creates the DB row and sets the HttpOnly cookie on the current response. Returns the session id (for audit). */
export async function issueAccessSessionCookie(input: CreateAccessSessionInput): Promise<{ sessionId: string }> {
  const rawToken = generateAccessToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACCESS_SESSION_TTL_MS);

  const [row] = await db
    .insert(candidateAccessSessions)
    .values({
      tokenHash: hashAccessToken(rawToken),
      cccdHmac: input.cccdHmac,
      scopedApplicationIds: input.scopedApplicationIds,
      verifiedAt: now,
      expiresAt,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    })
    .returning({ id: candidateAccessSessions.id });

  const store = await cookies();
  store.set(ACCESS_SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(ACCESS_SESSION_TTL_MS / 1000),
  });

  return { sessionId: row.id };
}

export async function clearAccessSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_SESSION_COOKIE);
}

export type ResolvedAccessSession = {
  id: string;
  scopedApplicationIds: string[];
  expiresAtMs: number;
  revokedAtMs: number | null;
};

/**
 * Reads the cookie, looks up the DB row by TOKEN HASH (never by raw token —
 * the raw token is never stored), and returns null unless the session is
 * genuinely valid right now (fail closed). Bumps last_used_at on success —
 * best-effort, never blocks the request.
 */
export async function resolveAccessSession(): Promise<ResolvedAccessSession | null> {
  const store = await cookies();
  const rawToken = store.get(ACCESS_SESSION_COOKIE)?.value;
  if (!rawToken) return null;

  const tokenHash = hashAccessToken(rawToken);
  const [row] = await db
    .select()
    .from(candidateAccessSessions)
    .where(eq(candidateAccessSessions.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;

  const scoped: ResolvedAccessSession = {
    id: row.id,
    scopedApplicationIds: Array.isArray(row.scopedApplicationIds) ? row.scopedApplicationIds : [],
    expiresAtMs: row.expiresAt.getTime(),
    revokedAtMs: row.revokedAt ? row.revokedAt.getTime() : null,
  };

  const now = Date.now();
  if (scoped.revokedAtMs !== null || now >= scoped.expiresAtMs) return null;

  db.update(candidateAccessSessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(candidateAccessSessions.id, row.id))
    .catch(() => {
      /* best-effort */
    });

  return scoped;
}

/** Convenience wrapper over lifecycle.sessionCanAccessApplication using a resolved session. */
export function sessionCanAccess(session: ResolvedAccessSession, applicationId: string, nowMs = Date.now()): boolean {
  return sessionCanAccessApplication(
    { revokedAtMs: session.revokedAtMs, expiresAtMs: session.expiresAtMs, scopedApplicationIds: session.scopedApplicationIds },
    applicationId,
    nowMs,
  );
}
