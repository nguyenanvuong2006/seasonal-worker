/**
 * ASSIGNMENT ACTOR — pure decision helper for the "who XẾP VIỆC" freeze.
 *
 * The assignment actor is frozen ONLY when a status genuinely transitions into
 * APPROVED from a non-APPROVED state. Every other save (editing a note/CCCD,
 * re-saving an already-APPROVED record, etc.) returns null and must NOT touch
 * the frozen actor fields.
 */
import { resolveDisplayName } from "./display-name.ts";

export type AssignmentActor = {
  assignedBy: string;
  assignedByDisplayName: string;
  assignedAt: Date;
};

export function resolveAssignmentActor(input: {
  previousStatus: string | null | undefined;
  nextStatus: string | null | undefined;
  username: string;
  fullName: string;
}): AssignmentActor | null {
  // Real assignment = transition into APPROVED from anything that is NOT already APPROVED.
  const isAssigning = input.nextStatus === "APPROVED" && input.previousStatus !== "APPROVED";
  if (!isAssigning) return null;

  return {
    assignedBy: input.username,
    assignedByDisplayName: resolveDisplayName({ fullName: input.fullName, username: input.username }),
    assignedAt: new Date(),
  };
}

/**
 * BACKWARD-COMPATIBLE ROLLOUT GATE — deploy-order safety (PR #114 pre-merge
 * blocker #2).
 *
 * The assignment-actor columns (`assigned_by` / `assigned_by_display_name` /
 * `assigned_at`) are created by an additive migration that runs SEPARATELY
 * from a Vercel code deploy (production migrations are operator-triggered via
 * GitHub Actions; they are NOT guaranteed to run before new code goes live).
 *
 * Until that additive migration has actually run, any approval write that
 * references those columns would fail with Postgres `undefined_column`
 * (SQLSTATE 42703). This gate keeps ordinary requests safe in the pre-
 * migration window:
 *
 *   PHASE A — deploy new code with this gate OFF (default). The code already
 *             UNDERSTANDS and can READ `ASSIGNED_BY_DISPLAY_NAME`; it simply
 *             does not WRITE the actor yet. No column dependency at runtime.
 *   PHASE B — run the additive column migration.
 *   PHASE C — set `ASSIGNMENT_ACTOR_WRITE_ENABLED=1` to enable the freeze.
 *
 * Fail-closed: while disabled, no actor is frozen. Newly-approved and
 * historical records resolve `Nguoi_tiep_nhan` to EMPTY — never to the merge
 * operator (no leak).
 */
export function isAssignmentActorWriteEnabled(): boolean {
  return process.env.ASSIGNMENT_ACTOR_WRITE_ENABLED === "1";
}

/**
 * Gated variant of `resolveAssignmentActor`. Use this in every write path that
 * would otherwise persist the frozen actor, so a pre-migration deployment can
 * never emit SQL against columns that do not exist yet.
 */
export function resolveAssignmentActorWrite(input: {
  previousStatus: string | null | undefined;
  nextStatus: string | null | undefined;
  username: string;
  fullName: string;
}): AssignmentActor | null {
  if (!isAssignmentActorWriteEnabled()) return null;
  return resolveAssignmentActor(input);
}
