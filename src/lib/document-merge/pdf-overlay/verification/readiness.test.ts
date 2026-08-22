import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitialReadinessState,
  updateGate,
  evaluateVisualGate,
  evaluateBenchmarkGate,
  evaluateStagingE2EGate,
  computeReadinessState,
} from "./readiness.ts";
import { runVisualVerification } from "./visual-harness.ts";
import { runBenchmark, createDefaultScenarios } from "./benchmark-harness.ts";
import { generateAllFixtures } from "./fixtures.ts";
import type { StagingE2EReport } from "./types.ts";

/** Báo cáo staging E2E hợp lệ (PASS) cho 1 hoặc 10 record. */
function validE2EReport(recordCount: 1 | 10): StagingE2EReport {
  const ids = Array.from({ length: recordCount }, (_, i) => `22222222-2222-4222-8222-${String(i + 1).padStart(12, "0")}`);
  return {
    generatedAt: "2026-08-22T00:00:00.000Z",
    recordCount,
    status: "PASS",
    jobId: "11111111-1111-4111-8111-111111111111",
    itemCount: recordCount,
    completed: recordCount,
    failed: 0,
    retryCount: 0,
    renderDurationMs: 1234,
    storageIds: ids.map((_, i) => `storage-${i}`),
    sha256s: ids.map((_, i) => `a`.repeat(64).slice(0, 62) + String(i).padStart(2, "0")),
    historyCount: recordCount,
    workerRevision: "staging-rev-1",
    outputUrls: ids.map((_, i) => `https://storage.test/${i}.pdf`),
    productionIsolation: {
      engineDefault: "GOOGLE_DOCS",
      activationAllowed: false,
      productionMutated: false,
      piiInFixtures: false,
    },
  };
}

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

test("readiness: canProceedToActivation chỉ true khi 4 gate tiền đề PASS", () => {
  let state = createInitialReadinessState();
  state = updateGate(state, "INFRASTRUCTURE_READY", "PASS");
  state = updateGate(state, "PDF_OVERLAY_IMPLEMENTED", "PASS");
  state = updateGate(state, "VISUAL_GATE_PENDING", "PASS");
  state = updateGate(state, "VISUAL_GATE_APPROVED", "PASS");
  state = updateGate(state, "BENCHMARK_GATE_PENDING", "PASS");
  state = updateGate(state, "BENCHMARK_GATE_APPROVED", "PASS");
  // Chưa có 2 E2E staging gates → chưa được phép proceed
  assert.equal(state.canProceedToActivation, false);
  state = updateGate(state, "STAGING_E2E_1_RECORD", "PASS");
  state = updateGate(state, "STAGING_E2E_10_RECORD", "PASS");
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

test("readiness: canProceedToActivation false khi 1 E2E staging gate FAIL", () => {
  let state = createInitialReadinessState();
  for (const gate of ["INFRASTRUCTURE_READY", "PDF_OVERLAY_IMPLEMENTED", "VISUAL_GATE_PENDING", "VISUAL_GATE_APPROVED", "BENCHMARK_GATE_PENDING", "BENCHMARK_GATE_APPROVED", "STAGING_E2E_1_RECORD"] as const) {
    state = updateGate(state, gate, "PASS");
  }
  state = updateGate(state, "STAGING_E2E_10_RECORD", "FAIL");
  assert.equal(state.canProceedToActivation, false);
});

test("readiness: ACTIVATION_ALLOWED không tự PASS khi updateGate — cần operator", () => {
  let state = createInitialReadinessState();
  for (const gate of ["INFRASTRUCTURE_READY", "PDF_OVERLAY_IMPLEMENTED", "VISUAL_GATE_PENDING", "VISUAL_GATE_APPROVED", "BENCHMARK_GATE_PENDING", "BENCHMARK_GATE_APPROVED", "STAGING_E2E_1_RECORD", "STAGING_E2E_10_RECORD"] as const) {
    state = updateGate(state, gate, "PASS");
  }
  assert.equal(state.canProceedToActivation, true, "đủ điều kiện tiền đề");
  assert.notEqual(state.gates.ACTIVATION_ALLOWED.status, "PASS", "ACTIVATION_ALLOWED không tự PASS");
  // Operator approval (PR6) — updateGate trực tiếp:
  state = updateGate(state, "ACTIVATION_ALLOWED", "PASS", "Operator approval PR6.");
  assert.equal(state.gates.ACTIVATION_ALLOWED.status, "PASS");
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
  assert.equal(state.gates.STAGING_E2E_1_RECORD.status, "PENDING");
  assert.equal(state.gates.STAGING_E2E_10_RECORD.status, "PENDING");
  assert.equal(state.gates.ACTIVATION_ALLOWED.status, "BLOCKED", "không bao giờ tự PASS");
  assert.equal(state.canProceedToActivation, false);
});

test("readiness: evaluateStagingE2EGate PASS khi report hợp lệ", () => {
  const eval_ = evaluateStagingE2EGate(validE2EReport(1));
  assert.equal(eval_.status, "PASS");
  assert.ok(eval_.reason.includes("job"));
});

test("readiness: evaluateStagingE2EGate FAIL khi completed thiếu / failed > 0 / history thiếu", () => {
  const bad1 = { ...validE2EReport(10), completed: 9 };
  assert.equal(evaluateStagingE2EGate(bad1).status, "FAIL");
  const bad2 = { ...validE2EReport(10), failed: 1 };
  assert.equal(evaluateStagingE2EGate(bad2).status, "FAIL");
  const bad3 = { ...validE2EReport(10), historyCount: 9 };
  assert.equal(evaluateStagingE2EGate(bad3).status, "FAIL");
  const bad4 = { ...validE2EReport(1), status: "FAIL" as const };
  assert.equal(evaluateStagingE2EGate(bad4).status, "FAIL");
});

test("readiness: evaluateStagingE2EGate FAIL khi production isolation bị vi phạm", () => {
  const bad = { ...validE2EReport(1), productionIsolation: { ...validE2EReport(1).productionIsolation, engineDefault: "HTML_PDF" as const } };
  assert.equal(evaluateStagingE2EGate(bad).status, "FAIL");
  // Type literal cấm piiInFixtures=true ở compile-time — cast để test runtime FAIL path
  const bad2 = { ...validE2EReport(1), productionIsolation: { ...validE2EReport(1).productionIsolation, piiInFixtures: true } } as unknown as StagingE2EReport;
  assert.equal(evaluateStagingE2EGate(bad2).status, "FAIL");
});

test("readiness: evaluateStagingE2EGate PENDING khi chưa có report", () => {
  assert.equal(evaluateStagingE2EGate(null).status, "PENDING");
  assert.equal(evaluateStagingE2EGate(undefined).status, "PENDING");
});

test("readiness: computeReadinessState cập nhật STAGING_E2E gates từ reports", async () => {
  const fixtures = await generateAllFixtures();
  const visualReport = await runVisualVerification(fixtures);
  const scenarios = await createDefaultScenarios();
  for (const s of scenarios) s.runCount = 2;
  const benchmarkReport = await runBenchmark(scenarios);

  // Cả visual + benchmark PASS (operator) + 2 E2E staging PASS
  const visualReportApproved = { ...visualReport, summary: { ...visualReport.summary, failed: 0, errors: 0 }, deterministic: true, warnings: [] };
  const state = computeReadinessState(visualReportApproved, benchmarkReport, {
    oneRecord: validE2EReport(1),
    tenRecord: validE2EReport(10),
  });
  assert.equal(state.gates.VISUAL_GATE_APPROVED.status, "PENDING", "visual vẫn cần operator review riêng");
  assert.equal(state.gates.STAGING_E2E_1_RECORD.status, "PASS");
  assert.equal(state.gates.STAGING_E2E_10_RECORD.status, "PASS");
  assert.equal(state.gates.ACTIVATION_ALLOWED.status, "BLOCKED", "ACTIVATION_ALLOWED vẫn BLOCKED (PR5)");
  assert.equal(state.canProceedToActivation, false, "visual benchmark chưa operator APPROVE");
});

test("readiness: computeReadinessState đủ 4 gate PASS → canProceedToActivation true nhưng ACTIVATION_ALLOWED BLOCKED", async () => {
  const fixtures = await generateAllFixtures();
  const visualReport = await runVisualVerification(fixtures);
  const scenarios = await createDefaultScenarios();
  for (const s of scenarios) s.runCount = 2;
  const benchmarkReport = await runBenchmark(scenarios);

  let state = computeReadinessState(visualReport, benchmarkReport, {
    oneRecord: validE2EReport(1),
    tenRecord: validE2EReport(10),
  });
  state = updateGate(state, "VISUAL_GATE_APPROVED", "PASS", "Operator visual approval");
  state = updateGate(state, "BENCHMARK_GATE_APPROVED", "PASS", "Operator benchmark approval");
  assert.equal(state.gates.STAGING_E2E_1_RECORD.status, "PASS");
  assert.equal(state.gates.STAGING_E2E_10_RECORD.status, "PASS");
  assert.equal(state.canProceedToActivation, true);
  assert.equal(state.gates.ACTIVATION_ALLOWED.status, "BLOCKED", "ACTIVATION_ALLOWED=NO — operator quyết định ở PR6");
});

test("readiness: computeReadinessState E2E 10-record FAIL → canProceedToActivation false", async () => {
  const fixtures = await generateAllFixtures();
  const visualReport = await runVisualVerification(fixtures);
  const scenarios = await createDefaultScenarios();
  for (const s of scenarios) s.runCount = 2;
  const benchmarkReport = await runBenchmark(scenarios);

  let state = computeReadinessState(visualReport, benchmarkReport, {
    oneRecord: validE2EReport(1),
    tenRecord: { ...validE2EReport(10), completed: 8, status: "FAIL" as const },
  });
  state = updateGate(state, "VISUAL_GATE_APPROVED", "PASS");
  state = updateGate(state, "BENCHMARK_GATE_APPROVED", "PASS");
  assert.equal(state.gates.STAGING_E2E_1_RECORD.status, "PASS");
  assert.equal(state.gates.STAGING_E2E_10_RECORD.status, "FAIL");
  assert.equal(state.canProceedToActivation, false);
  assert.equal(state.gates.ACTIVATION_ALLOWED.status, "BLOCKED");
});
