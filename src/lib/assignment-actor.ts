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
