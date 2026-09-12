import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "crypto";
import type { ResetScope } from "./scopes";

/**
 * WORKFORCE DATA MANAGEMENT — reset preview token (mission section 6).
 * Execution must be bound to the EXACT preview the caller saw: a token
 * minted for FINGERPRINT can never be replayed against a WORKFORCE
 * execute call. Reuses the app's existing AUTH_SECRET/jose signing
 * primitive (same as session cookies in lib/auth.ts) rather than inventing
 * a second secret/signing scheme.
 *
 * Short expiry (5 minutes) and a hash of the row-count snapshot the caller
 * was shown — if the underlying data changes between preview and execute
 * (someone else imported/edited data in the meantime), the hash mismatches
 * and execute is refused (RESET_PLAN_CHANGED) rather than silently
 * executing against a plan the caller never actually saw.
 */

const TOKEN_TTL = "5m";

export type ResetPreviewTokenPayload = {
  actor: string;
  requestedScopes: ResetScope[];
  effectiveScopes: ResetScope[];
  environment: string;
  countsHash: string;
};

function secretKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required");
  return new TextEncoder().encode(secret);
}

/** Deterministic hash of the exact (domain, rowCount) pairs shown to the caller — order-independent (sorted by domain key first). */
export function hashRowCounts(counts: { domain: string; rows: number }[]): string {
  const sorted = [...counts].sort((a, b) => a.domain.localeCompare(b.domain));
  const canonical = sorted.map((c) => `${c.domain}:${c.rows}`).join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export async function signResetPreviewToken(payload: ResetPreviewTokenPayload): Promise<{ token: string; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secretKey());
  return { token, expiresAt: expiresAt.toISOString() };
}

export type ResetPreviewTokenVerifyResult = { ok: true; payload: ResetPreviewTokenPayload } | { ok: false; reason: "EXPIRED" | "INVALID" };

export async function verifyResetPreviewToken(token: string): Promise<ResetPreviewTokenVerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return {
      ok: true,
      payload: {
        actor: String(payload.actor),
        requestedScopes: payload.requestedScopes as ResetScope[],
        effectiveScopes: payload.effectiveScopes as ResetScope[],
        environment: String(payload.environment),
        countsHash: String(payload.countsHash),
      },
    };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "EXPIRED" };
    return { ok: false, reason: "INVALID" };
  }
}
