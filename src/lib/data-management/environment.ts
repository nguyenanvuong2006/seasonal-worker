/**
 * WORKFORCE DATA MANAGEMENT — environment guard (mission section 7 + 42).
 * Pure (no DB, no "server-only") so it is trivially unit-testable and can be
 * called from anywhere without pulling in DB/session code.
 *
 * ABSOLUTE RULE for this mission: Production destructive reset is NEVER
 * authorized. This module is the SINGLE place that decides "are we allowed
 * to run a destructive data-management operation right now" — every
 * reset/import-execute code path MUST call it, and there is no other way to
 * bypass it (no UI switch, no per-request override, no role bypass —
 * ADMIN included).
 *
 * Environment resolution:
 *   - Vercel sets VERCEL_ENV to "production" only for the actual Production
 *     deployment (custom domain/production branch) — "preview" for every PR
 *     preview build, unset for local dev. NODE_ENV alone is NOT a reliable
 *     signal here: Next.js sets NODE_ENV=production for every `next build`,
 *     including preview deployments, which would otherwise misclassify a
 *     preview environment as Production.
 *   - Falls back to NODE_ENV only when VERCEL_ENV is absent (e.g. local
 *     `next build && next start` without Vercel) — conservatively treats an
 *     unrecognized/absent signal as "development" (never silently unlocks
 *     destructive operations from an ambiguous signal).
 */

export type DataManagementEnvironment = "development" | "preview" | "production";

export function resolveDataManagementEnvironment(): DataManagementEnvironment {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production") return "production";
  if (vercelEnv === "preview") return "preview";
  if (vercelEnv === "development") return "development";
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export type DataResetGuardResult = { allowed: true; environment: DataManagementEnvironment } | { allowed: false; environment: DataManagementEnvironment; reason: string };

/**
 * The one function every destructive reset/import-execute path calls before
 * doing anything else. Two independent kill switches, both read fresh on
 * every call (never cached, never a DB row an Admin could toggle):
 *
 *   1. DATA_RESET_MODE=DISABLED — a hard, environment-independent lock (go-
 *      live lock, mission section 42). Once set, destructive operations are
 *      off everywhere, including local dev, until an operator unsets it.
 *   2. Production itself — destructive operations are off in `production`
 *      unless ALLOW_PRODUCTION_DATA_RESET is literally the string "true".
 *      This repo/mission never sets that variable — Production stays locked
 *      by construction, not by convention.
 */
export function checkDataResetAllowed(): DataResetGuardResult {
  const environment = resolveDataManagementEnvironment();

  if (process.env.DATA_RESET_MODE === "DISABLED") {
    return { allowed: false, environment, reason: "Destructive data operations have been permanently disabled for this deployment (DATA_RESET_MODE=DISABLED)." };
  }

  if (environment === "production" && process.env.ALLOW_PRODUCTION_DATA_RESET !== "true") {
    return { allowed: false, environment, reason: "Reset dữ liệu trên Production hiện đang bị khóa." };
  }

  return { allowed: true, environment };
}
