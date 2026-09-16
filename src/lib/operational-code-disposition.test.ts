import test from "node:test";
import assert from "node:assert/strict";
import { decideSameDayOperationalCodeDisposition } from "./operational-code-disposition.ts";

/**
 * Pure unit tests for the shared operational-code disposition policy.
 * No DB stubs needed — this is a pure function.
 */

// ── RETURNING worker ──────────────────────────────────────────────────

test("RETURNING + NO_SHOW → PRESERVE regardless of provenance", () => {
  assert.equal(
    decideSameDayOperationalCodeDisposition({
      outcome: "NO_SHOW",
      isReturningWorker: true,
      codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: true },
    }),
    "PRESERVE_EXISTING_CODES",
  );
});

test("RETURNING + DECLINED_AT_START → PRESERVE regardless of provenance", () => {
  assert.equal(
    decideSameDayOperationalCodeDisposition({
      outcome: "DECLINED_AT_START",
      isReturningWorker: true,
      codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: true },
    }),
    "PRESERVE_EXISTING_CODES",
  );
});

test("RETURNING + provenance false → PRESERVE", () => {
  assert.equal(
    decideSameDayOperationalCodeDisposition({
      outcome: "NO_SHOW",
      isReturningWorker: true,
      codeProvenance: { dwCodeBelongsToCurrentSession: false, itCodeBelongsToCurrentSession: false },
    }),
    "PRESERVE_EXISTING_CODES",
  );
});

// ── NEW worker + provenance proven ────────────────────────────────────

test("NEW + NO_SHOW + both provenances proven → RELEASE", () => {
  assert.equal(
    decideSameDayOperationalCodeDisposition({
      outcome: "NO_SHOW",
      isReturningWorker: false,
      codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: true },
    }),
    "RELEASE_CURRENT_ENGAGEMENT_CODES",
  );
});

test("NEW + DECLINED_AT_START + both provenances proven → RELEASE", () => {
  assert.equal(
    decideSameDayOperationalCodeDisposition({
      outcome: "DECLINED_AT_START",
      isReturningWorker: false,
      codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: true },
    }),
    "RELEASE_CURRENT_ENGAGEMENT_CODES",
  );
});

// ── NEW worker + provenance NOT proven (fail-safe) ────────────────────

test("NEW + NO_SHOW + DW provenance uncertain → PRESERVE (fail-safe)", () => {
  assert.equal(
    decideSameDayOperationalCodeDisposition({
      outcome: "NO_SHOW",
      isReturningWorker: false,
      codeProvenance: { dwCodeBelongsToCurrentSession: false, itCodeBelongsToCurrentSession: true },
    }),
    "PRESERVE_EXISTING_CODES",
  );
});

test("NEW + NO_SHOW + IT provenance uncertain → PRESERVE (fail-safe)", () => {
  assert.equal(
    decideSameDayOperationalCodeDisposition({
      outcome: "NO_SHOW",
      isReturningWorker: false,
      codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: false },
    }),
    "PRESERVE_EXISTING_CODES",
  );
});

test("NEW + NO_SHOW + both provenances uncertain → PRESERVE (fail-safe)", () => {
  assert.equal(
    decideSameDayOperationalCodeDisposition({
      outcome: "NO_SHOW",
      isReturningWorker: false,
      codeProvenance: { dwCodeBelongsToCurrentSession: false, itCodeBelongsToCurrentSession: false },
    }),
    "PRESERVE_EXISTING_CODES",
  );
});
