/**
 * ASSIGNMENT ACTOR — freeze decision (pure).
 *
 * The actor is frozen ONLY on a genuine non-APPROVED → APPROVED transition.
 * Unrelated saves and re-saves of an already-APPROVED record must NOT
 * overwrite the frozen actor. An explicit reset-then-re-approve by a new user
 * produces the NEW user as the latest actor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAssignmentActor } from "./assignment-actor.ts";

test("assignment freezes actor: non-APPROVED → APPROVED (User A)", () => {
  const actor = resolveAssignmentActor({
    previousStatus: "PENDING",
    nextStatus: "APPROVED",
    username: "anvuong",
    fullName: "An Vượng",
  });
  assert.ok(actor);
  assert.equal(actor.assignedBy, "anvuong");
  assert.equal(actor.assignedByDisplayName, "An Vượng");
});

test("unrelated save does NOT overwrite actor (no status change)", () => {
  assert.equal(
    resolveAssignmentActor({ previousStatus: "APPROVED", nextStatus: undefined, username: "b", fullName: "User B" }),
    null,
  );
  assert.equal(
    resolveAssignmentActor({ previousStatus: "PENDING", nextStatus: null, username: "b", fullName: "User B" }),
    null,
  );
});

test("unrelated save does NOT overwrite actor (re-saving already-APPROVED)", () => {
  assert.equal(
    resolveAssignmentActor({ previousStatus: "APPROVED", nextStatus: "APPROVED", username: "b", fullName: "User B" }),
    null,
  );
});

test("explicit re-approval by User C updates actor to User C", () => {
  const actor = resolveAssignmentActor({
    previousStatus: "PENDING", // record was reset out of APPROVED
    nextStatus: "APPROVED",
    username: "user_c",
    fullName: "User C",
  });
  assert.ok(actor);
  assert.equal(actor.assignedBy, "user_c");
  assert.equal(actor.assignedByDisplayName, "User C");
});

test("displayName preferred over username via centralized resolver (Vietnamese Unicode)", () => {
  // fullName present → used; username is only the fallback identity.
  const actor = resolveAssignmentActor({
    previousStatus: "NEW",
    nextStatus: "APPROVED",
    username: "tranmai",
    fullName: "Trần Mai",
  });
  assert.equal(actor?.assignedByDisplayName, "Trần Mai");
  assert.equal(actor?.assignedBy, "tranmai");
});
