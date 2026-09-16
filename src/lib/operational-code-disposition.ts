/**
 * OPERATIONAL CODE DISPOSITION — shared, pure business-policy helper for
 * same-day lifecycle NO_SHOW / DECLINED_AT_START outcomes.
 * -----------------------------------------------------------------------
 * Decides whether the system should RELEASE or PRESERVE a worker's
 * Internal DW Code and IT Code when the worker's same-day engagement ends
 * due to NO_SHOW or DECLINED_AT_START.
 *
 * THIS MODULE IS PURE LOGIC — no DB, no "server-only", no side-effects.
 * It is the SINGLE source of truth for the release-or-preserve decision;
 * both code types (DW Code + IT Code) follow the SAME policy — never
 * duplicated.
 *
 * RULES (authoritative business rule, explicit guards):
 *
 * 1. RETURNING WORKER (has prior real Employment history before the
 *    current engagement): PRESERVE_EXISTING_CODES. Always. The worker may
 *    already own/use their historical codes from a previous stint.
 *    "Returning" is determined STRICTLY by prior employment_sessions
 *    rows — never inferred from worker_profiles, dw_data, code presence,
 *    department, code prefix, or same-day registration alone.
 *
 * 2. NEW WORKER (no prior employment history) + current-engagement
 *    provenance positively proven for BOTH codes: RELEASE. The code was
 *    newly assigned specifically for this engagement, so releasing it is
 *    safe. Provenance is proven by assignment.employmentSessionId ===
 *    currentSessionId (canonical). If provenance is uncertain or only a
 *    legacy mirror exists, PRESERVE (fail-safe).
 *
 * 3. STARTED_THEN_LEFT: this function is NEVER called for that outcome.
 *    STARTED_THEN_LEFT uses the existing finalizeResignationEffect()
 *    resignation/code-release semantics — unchanged.
 *
 * 4. FAIL-SAFE: if any condition cannot be proven, PRESERVE.
 */

export type OperationalCodeDisposition =
  | "RELEASE_CURRENT_ENGAGEMENT_CODES"
  | "PRESERVE_EXISTING_CODES";

/**
 * Evidence that a code assignment was created specifically for the current
 * engagement/session. Both DW Code and IT Code share this shape.
 *
 * - `true`  = an active assignment row exists AND its employmentSessionId
 *             matches the current session.
 * - `false` = either no active assignment exists, or it belongs to a
 *             different session, or we cannot positively prove provenance
 *             (legacy mirror only, uncertain).
 */
export type CodeProvenanceEvidence = {
  dwCodeBelongsToCurrentSession: boolean;
  itCodeBelongsToCurrentSession: boolean;
};

export type SameDayOutcomeForDisposition = "NO_SHOW" | "DECLINED_AT_START";

export type DispositionInput = {
  /** Must be NO_SHOW or DECLINED_AT_START. STARTED_THEN_LEFT never uses this. */
  outcome: SameDayOutcomeForDisposition;
  /**
   * True if the worker has ANY prior real employment_sessions row before
   * the current session (any status, including ENDED). Determined purely
   * from employment history — never from code presence, dw_data existence,
   * worker_profiles, department, or code prefix.
   */
  isReturningWorker: boolean;
  /**
   * Evidence that each operational code was newly assigned specifically for
   * the current engagement. Both must be positively proven for release.
   */
  codeProvenance: CodeProvenanceEvidence;
};

/**
 * Decide whether to release or preserve operational codes for a same-day
 * NO_SHOW / DECLINED_AT_START event.
 *
 * The SAME policy governs DW Code and IT Code — never duplicated.
 */
export function decideSameDayOperationalCodeDisposition(
  input: DispositionInput,
): OperationalCodeDisposition {
  // Guard 1: RETURNING worker → always preserve.
  if (input.isReturningWorker) {
    return "PRESERVE_EXISTING_CODES";
  }

  // Guard 2: NEW worker → release ONLY when current-engagement provenance
  // is positively proven for BOTH code types. If either cannot be proven,
  // fail-safe to PRESERVE.
  if (
    input.codeProvenance.dwCodeBelongsToCurrentSession &&
    input.codeProvenance.itCodeBelongsToCurrentSession
  ) {
    return "RELEASE_CURRENT_ENGAGEMENT_CODES";
  }

  // Fail-safe: provenance uncertain → preserve.
  return "PRESERVE_EXISTING_CODES";
}
