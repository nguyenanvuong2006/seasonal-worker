/**
 * Type declarations for bootstrap-content-guard.mjs — hand-written, not
 * generated. Same rationale as migration-ledger.d.mts.
 */

export interface BootstrapContentCheckResult {
  ok: boolean;
  reason: string | null;
}

export function checkBootstrapContentAllowed(sqlText: string): BootstrapContentCheckResult;
