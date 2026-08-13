import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's native TypeScript test runner requires the explicit extension.
import { isQuestionForAudience, normalizeTargetAudience, type TargetedQuestion } from "./form-targeting.ts";

const question = (overrides: Partial<TargetedQuestion> = {}): TargetedQuestion => ({
  visibleToApplicants: true,
  targetAudience: "ALL",
  skipForReturning: false,
  ...overrides,
});

test("ALL applies to new and returning applicants", () => {
  assert.equal(isQuestionForAudience(question(), "NEW"), true);
  assert.equal(isQuestionForAudience(question(), "RETURNING"), true);
});

test("NEW_ONLY applies only to new applicants", () => {
  const targeted = question({ targetAudience: "NEW_ONLY" });
  assert.equal(isQuestionForAudience(targeted, "NEW"), true);
  assert.equal(isQuestionForAudience(targeted, "RETURNING"), false);
});

test("RETURNING_ONLY applies only to returning applicants", () => {
  const targeted = question({ targetAudience: "RETURNING_ONLY" });
  assert.equal(isQuestionForAudience(targeted, "NEW"), false);
  assert.equal(isQuestionForAudience(targeted, "RETURNING"), true);
});

test("applicant-invisible questions never apply", () => {
  const targeted = question({ visibleToApplicants: false });
  assert.equal(isQuestionForAudience(targeted, "NEW"), false);
  assert.equal(isQuestionForAudience(targeted, "RETURNING"), false);
});

test("skipForReturning overrides ALL and RETURNING_ONLY", () => {
  assert.equal(
    isQuestionForAudience(question({ skipForReturning: true }), "RETURNING"),
    false,
  );
  assert.equal(
    isQuestionForAudience(
      question({ targetAudience: "RETURNING_ONLY", skipForReturning: true }),
      "RETURNING",
    ),
    false,
  );
});

test("unknown persisted audience values safely normalize to ALL", () => {
  assert.equal(normalizeTargetAudience("UNKNOWN"), "ALL");
  assert.equal(isQuestionForAudience(question({ targetAudience: "UNKNOWN" }), "NEW"), true);
  assert.equal(
    isQuestionForAudience(question({ targetAudience: "UNKNOWN" }), "RETURNING"),
    true,
  );
});
