/**
 * OPERATIONAL CODE DISPOSITION — shared, pure business-policy helper for
 * same-day lifecycle NO_SHOW / DECLINED_AT_START outcomes.
 * -----------------------------------------------------------------------
 * Decides **independently** for each operational code (DW Code and IT Code)
 * whether the system should RELEASE or PRESERVE it when the worker's
 * same-day engagement ends due to NO_SHOW or DECLINED_AT_START.
 *
 * THIS MODULE IS PURE LOGIC — no DB, no "server-only", no side-effects.
 * It is the SINGLE source of truth for the release-or-preserve decision.
 *
 * RULES (authoritative business rule, explicit guards):
 *
 * 1. RETURNING WORKER (has prior real Employment history before the
 *    current engagement): PRESERVE both codes. Always. The worker may
 *    already own/use their historical codes from a previous stint.
 *    "Returning" is determined STRICTLY by prior employment_sessions
 *    rows — never inferred from worker_profiles, dw_data, code presence,
 *    department, code prefix, or same-day registration alone.
 *
 * 2. NEW WORKER (no prior employment history): each code is decided
 *    INDEPENDENTLY based on its own provenance:
 *      - DW provenance proven (assignment.employmentSessionId ===
 *        currentSessionId) → RELEASE DW code.
 *      - DW provenance uncertain (legacy mirror only, no matching
 *        assignment) → PRESERVE DW code (fail-safe).
 *      - IT provenance proven → RELEASE IT code.
 *      - IT provenance uncertain → PRESERVE IT code (fail-safe).
 *
 * 3. STARTED_THEN_LEFT: this function is NEVER called for that outcome.
 *    STARTED_THEN_LEFT uses the existing finalizeResignationEffect()
 *    resignation/code-release semantics — unchanged.
 *
 * 4. FAIL-SAFE: if any condition cannot be proven for a given code,
 *    PRESERVE that code.
 */

export type SingleCodeDisposition = "RELEASE" | "PRESERVE";

/**
 * Per-code disposition result. Each code gets its own independent decision.
 */
export type OperationalCodeDispositionResult = {
  dwCode: SingleCodeDisposition;
  itCode: SingleCodeDisposition;
};

/**
 * Evidence that a code assignment was created specifically for the current
 * engagement/session. Each code type has its own provenance flag.
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
   * the current engagement. Each code is evaluated independently.
   */
  codeProvenance: CodeProvenanceEvidence;
};

/**
 * Decide whether to release or preserve each operational code for a same-day
 * NO_SHOW / DECLINED_AT_START event.
 *
 * Returns independent decisions for DW Code and IT Code.
 */
export function decideSameDayOperationalCodeDisposition(
  input: DispositionInput,
): OperationalCodeDispositionResult {
  // Guard 1: RETURNING worker → always preserve BOTH codes.
  if (input.isReturningWorker) {
    return { dwCode: "PRESERVE", itCode: "PRESERVE" };
  }

  // Guard 2: NEW worker → release each code INDEPENDENTLY based on its
  // own provenance. If provenance is uncertain, fail-safe to PRESERVE.
  return {
    dwCode: input.codeProvenance.dwCodeBelongsToCurrentSession ? "RELEASE" : "PRESERVE",
    itCode: input.codeProvenance.itCodeBelongsToCurrentSession ? "RELEASE" : "PRESERVE",
  };
}
