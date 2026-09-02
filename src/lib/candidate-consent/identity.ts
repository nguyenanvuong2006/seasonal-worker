/**
 * Identity normalization + masking for the candidate-consent flow.
 * Pure functions only — no DB, no crypto secret handling beyond hashing
 * given inputs (the actual server secret is supplied by the caller).
 */

import { hmacSha256Hex } from "./evidence.ts";

export function normalizeCccd(raw: unknown): string {
  return String(raw ?? "").trim();
}

export function normalizePhone(raw: unknown): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/** "001234567890" -> "0012****7890" — never show the full number in ordinary UI. */
export function maskCccd(cccd: string): string {
  if (cccd.length <= 6) return "*".repeat(cccd.length);
  return `${cccd.slice(0, 4)}${"*".repeat(cccd.length - 8)}${cccd.slice(-4)}`;
}

export function maskPhone(phone: string): string {
  if (phone.length <= 4) return "*".repeat(phone.length);
  return `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}

/**
 * Deterministic, non-reversible correlation key for one identity lookup
 * attempt — used ONLY as a rate-limit bucket key, never to reconstruct the
 * original CCCD/phone. Combines IP so a single leaked/guessed CCCD can't be
 * hammered from many IPs without also being throttled per-IP separately
 * (see rate-limiter.ts, which limits by BOTH keys).
 */
export function identityLimiterKey(cccd: string, phone: string, secret: string): string {
  return hmacSha256Hex(`identity:${normalizeCccd(cccd)}:${normalizePhone(phone)}`, secret);
}

export function ipLimiterKey(ip: string, secret: string): string {
  return hmacSha256Hex(`ip:${ip}`, secret);
}

export function cccdHmac(cccd: string, secret: string): string {
  return hmacSha256Hex(`cccd:${normalizeCccd(cccd)}`, secret);
}
