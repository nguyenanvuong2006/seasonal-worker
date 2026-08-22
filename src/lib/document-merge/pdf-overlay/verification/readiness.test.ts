import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitialReadinessState,
  updateGate,
  evaluateVisualGate,
  evaluateBenchmarkGate,
  computeReadinessState,
} from "./readiness.ts";
import { runVisualVerification } from "./visual-harness.ts";
import { runBenchmark, createDefaultScenarios } from "./benchmark-harness.ts";
import { generateAllFixtures } from "./fixtures.ts";

test("readiness: createInitialReadinessState trả về state mặc định", () => {
  const state = createInitialReadinessState();
  assert.equal(state.currentGate, "INFRASTRUCTURE_READY");
  assert.equal(state.canProceedToActivation, false);
  assert.ok(state.notes.length > 0);
  for (const gate of Object.values(state.gates)) {
    assert.equal(gate.status, "PENDING");
  }
});

test("readiness: updateGate cập nhật trạng thái gate", () => {
  let state = createInitialReadinessState();
  state = updateGate(state, "INFRASTRUCTURE_READY", "PASS", "Test");
  assert.equal(state.gates.INFRASTRUCTURE_READY.status, "PASS");
  assert.equal(state.gates.INFRASTRUCTURE_READY.reason, "Test");
  assert.ok(state.gates.INFRASTRUCTURE_READY.verifiedAt);
});

test("readiness: updateGate cập nhật currentGate", () => {
  let state = createInitialReadinessState();
  state = updateGate(state, "INFRASTRUCTURE_READY", "PASS");
  state = updateGate(state, "PDF_OVERLAY_IMPLEMENTED", "PASS");
  assert.equal(state.currentGate, "PDF_OVERLAY_IMPLEMENTED");
});

test("readiness: canProceedToActivation chỉ true khi cả 2 gate APPROVED", () => {
  let state = createInitialReadinessState();
  state = updateGate(state, "INFRASTRUCTURE_READY", "PASS");
  state = updateGate(state, "PDF_OVERLAY_IMPLEMENTED", "PASS");
  state = updateGate(state, "VISUAL_GATE_PENDING", "PASS");
  state = updateGate(state, "VISUAL_GATE_APPROVED", "PASS");
  state = updateGate(state, "BENCHMARK_GATE_PENDING", "PASS");
  state = updateGate(state, "BENCHMARK_GATE_APPROVED", "PASS");
  assert.equal(state.canProceedToActivation, true);
});

test("readiness: canProceedToActivation false khi thiếu gate", () => {
  let state = createInitialReadinessState();
  state = updateGate(state, "INFRASTRUCTURE_READY", "PASS");
  state = updateGate(state, "PDF_OVERLAY_IMPLEMENTED", "PASS");
  state = updateGate(state, "VISUAL_GATE_PENDING", "PASS");
  state = updateGate(state, "VISUAL_GATE_APPROVED", "PASS");
  // BENCHMARK_GATE_APPROVED vẫn PENDING
  assert.equal(state.canProceedToActivation, false);
});

test("readiness: evaluateVisualGate trả PENDING_OPERATOR_REVIEW khi tất cả PASS", async () => {
  const fixtures = await generateAllFixtures();
  const report = await runVisualVerification(fixtures);
  const eval_ = evaluateVisualGate(report);
  assert.equal(eval_.status, "PENDING_OPERATOR_REVIEW");
  assert.ok(eval_.reason.includes("operator review"));
});

test("readiness: evaluateVisualGate trả FAIL khi có errors", async () => {
  const fixtures = await generateAllFixtures();
  const report = await runVisualVerification(fixtures);
  report.summary.errors = 1;
  const eval_ = evaluateVisualGate(report);
  assert.equal(eval_.status, "FAIL");
});

test("readiness: evaluateVisualGate trả FAIL khi không deterministic", async () => {
  const fixtures = await generateAllFixtures();
  const report = await runVisualVerification(fixtures);
  report.deterministic = false;
  const eval_ = evaluateVisualGate(report);
  assert.equal(eval_.status, "FAIL");
});

test("readiness: evaluateBenchmarkGate trả PENDING_OPERATOR_REVIEW khi không có thresholds", async () => {
  const scenarios = await createDefaultScenarios();
  for (const s of scenarios) s.runCount = 2;
  const report = await runBenchmark(scenarios);
  delete report.thresholds;
  const eval_ = evaluateBenchmarkGate(report);
  assert.equal(eval_.status, "PENDING_OPERATOR_REVIEW");
});

test("readiness: evaluateBenchmarkGate trả FAIL khi SHA không deterministic", async () => {
  const scenarios = await createDefaultScenarios();
  for (const s of scenarios) s.runCount = 2;
  const report = await runBenchmark(scenarios);
  report.scenarios[0].summary.deterministicSha = false;
  const eval_ = evaluateBenchmarkGate(report);
  assert.equal(eval_.status, "FAIL");
});

test("readiness: computeReadinessState tính state từ reports", async () => {
  const fixtures = await generateAllFixtures();
  const visualReport = await runVisualVerification(fixtures);
  const scenarios = await createDefaultScenarios();
  for (const s of scenarios) s.runCount = 2;
  const benchmarkReport = await runBenchmark(scenarios);
  const state = computeReadinessState(visualReport, benchmarkReport);
  assert.equal(state.gates.INFRASTRUCTURE_READY.status, "PASS");
  assert.equal(state.gates.PDF_OVERLAY_IMPLEMENTED.status, "PASS");
  assert.equal(state.gates.VISUAL_GATE_PENDING.status, "PASS");
  assert.equal(state.gates.VISUAL_GATE_APPROVED.status, "PENDING");
  assert.equal(state.gates.BENCHMARK_GATE_PENDING.status, "PASS");
  assert.equal(state.gates.BENCHMARK_GATE_APPROVED.status, "PENDING");
  assert.equal(state.gates.ACTIVATION_ALLOWED.status, "BLOCKED");
  assert.equal(state.canProceedToActivation, false);
});

test("readiness: computeReadinessState với null reports", () => {
  const state = computeReadinessState(null, null);
  assert.equal(state.gates.INFRASTRUCTURE_READY.status, "PASS");
  assert.equal(state.gates.PDF_OVERLAY_IMPLEMENTED.status, "PASS");
  assert.equal(state.gates.VISUAL_GATE_PENDING.status, "PENDING");
  assert.equal(state.gates.BENCHMARK_GATE_PENDING.status, "PENDING");
  assert.equal(state.canProceedToActivation, false);
});
