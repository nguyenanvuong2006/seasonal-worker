import test from "node:test";
import assert from "node:assert/strict";
import { decideSameDayOperationalCodeDisposition } from "./operational-code-disposition.ts";

/**
 * Pure unit tests for the shared operational-code disposition policy.
 * No DB stubs needed — this is a pure function.
 *
 * The policy returns INDEPENDENT per-code decisions:
 *   { dwCode: "RELEASE" | "PRESERVE", itCode: "RELEASE" | "PRESERVE" }
 */

// ── RETURNING worker ──────────────────────────────────────────────────

test("RETURNING + NO_SHOW → PRESERVE both regardless of provenance", () => {
  const result = decideSameDayOperationalCodeDisposition({
    outcome: "NO_SHOW",
    isReturningWorker: true,
    codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: true },
  });
  assert.equal(result.dwCode, "PRESERVE");
  assert.equal(result.itCode, "PRESERVE");
});

test("RETURNING + DECLINED_AT_START → PRESERVE both regardless of provenance", () => {
  const result = decideSameDayOperationalCodeDisposition({
    outcome: "DECLINED_AT_START",
    isReturningWorker: true,
    codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: true },
  });
  assert.equal(result.dwCode, "PRESERVE");
  assert.equal(result.itCode, "PRESERVE");
});

test("RETURNING + provenance false → PRESERVE both", () => {
  const result = decideSameDayOperationalCodeDisposition({
    outcome: "NO_SHOW",
    isReturningWorker: true,
    codeProvenance: { dwCodeBelongsToCurrentSession: false, itCodeBelongsToCurrentSession: false },
  });
  assert.equal(result.dwCode, "PRESERVE");
  assert.equal(result.itCode, "PRESERVE");
});

// ── NEW worker + both provenances proven ──────────────────────────────

test("NEW + NO_SHOW + both provenances proven → RELEASE both", () => {
  const result = decideSameDayOperationalCodeDisposition({
    outcome: "NO_SHOW",
    isReturningWorker: false,
    codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: true },
  });
  assert.equal(result.dwCode, "RELEASE");
  assert.equal(result.itCode, "RELEASE");
});

test("NEW + DECLINED_AT_START + both provenances proven → RELEASE both", () => {
  const result = decideSameDayOperationalCodeDisposition({
    outcome: "DECLINED_AT_START",
    isReturningWorker: false,
    codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: true },
  });
  assert.equal(result.dwCode, "RELEASE");
  assert.equal(result.itCode, "RELEASE");
});

// ── NEW worker + per-code independent provenance (PR #217 fix) ────────

test("NEW + DW provenance true + IT provenance false → release DW, preserve IT", () => {
  const result = decideSameDayOperationalCodeDisposition({
    outcome: "NO_SHOW",
    isReturningWorker: false,
    codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: false },
  });
  assert.equal(result.dwCode, "RELEASE", "DW must be released when provenance is proven");
  assert.equal(result.itCode, "PRESERVE", "IT must be preserved when provenance is uncertain");
});

test("NEW + DW provenance false + IT provenance true → preserve DW, release IT", () => {
  const result = decideSameDayOperationalCodeDisposition({
    outcome: "NO_SHOW",
    isReturningWorker: false,
    codeProvenance: { dwCodeBelongsToCurrentSession: false, itCodeBelongsToCurrentSession: true },
  });
  assert.equal(result.dwCode, "PRESERVE", "DW must be preserved when provenance is uncertain");
  assert.equal(result.itCode, "RELEASE", "IT must be released when provenance is proven");
});

test("NEW + both provenances uncertain → PRESERVE both (fail-safe)", () => {
  const result = decideSameDayOperationalCodeDisposition({
    outcome: "NO_SHOW",
    isReturningWorker: false,
    codeProvenance: { dwCodeBelongsToCurrentSession: false, itCodeBelongsToCurrentSession: false },
  });
  assert.equal(result.dwCode, "PRESERVE");
  assert.equal(result.itCode, "PRESERVE");
});

// ── DECLINED_AT_START per-code independence ───────────────────────────

test("NEW + DECLINED_AT_START + DW true + IT false → release DW, preserve IT", () => {
  const result = decideSameDayOperationalCodeDisposition({
    outcome: "DECLINED_AT_START",
    isReturningWorker: false,
    codeProvenance: { dwCodeBelongsToCurrentSession: true, itCodeBelongsToCurrentSession: false },
  });
  assert.equal(result.dwCode, "RELEASE");
  assert.equal(result.itCode, "PRESERVE");
});

test("NEW + DECLINED_AT_START + DW false + IT true → preserve DW, release IT", () => {
  const result = decideSameDayOperationalCodeDisposition({
    outcome: "DECLINED_AT_START",
    isReturningWorker: false,
    codeProvenance: { dwCodeBelongsToCurrentSession: false, itCodeBelongsToCurrentSession: true },
  });
  assert.equal(result.dwCode, "PRESERVE");
  assert.equal(result.itCode, "RELEASE");
});
