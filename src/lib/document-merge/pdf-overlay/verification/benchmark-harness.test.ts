import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultScenarios,
  runScenario,
  runBenchmark,
  evaluateThresholds,
} from "./benchmark-harness.ts";
import { readEmbeddedFontBytes } from "../vietnamese-font.ts";
import type { BenchmarkThresholds } from "./types.ts";

const fontBytes = readEmbeddedFontBytes();

test("benchmark: createDefaultScenarios trả về ít nhất 3 scenarios", async () => {
  const scenarios = await createDefaultScenarios();
  assert.ok(scenarios.length >= 3);
});

test("benchmark: mỗi scenario có id duy nhất", async () => {
  const scenarios = await createDefaultScenarios();
  const ids = scenarios.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("benchmark: runScenario trả về kết quả hợp lệ", async () => {
  const scenarios = await createDefaultScenarios();
  const scenario = scenarios[0];
  scenario.runCount = 3; // giảm để test nhanh
  const result = await runScenario(scenario, fontBytes);
  assert.equal(result.runs.length, 3);
  assert.ok(result.summary.avgDurationMs > 0);
  assert.ok(result.summary.p50DurationMs > 0);
  assert.ok(result.summary.p95DurationMs > 0);
  assert.ok(result.summary.avgOutputBytes > 0);
  assert.equal(result.summary.deterministicSha, true);
});

test("benchmark: runScenario SHA deterministic", async () => {
  const scenarios = await createDefaultScenarios();
  const scenario = scenarios[0];
  scenario.runCount = 5;
  const result = await runScenario(scenario, fontBytes);
  const shas = new Set(result.runs.map((r) => r.sha256));
  assert.equal(shas.size, 1);
  assert.equal(result.summary.deterministicSha, true);
});

test("benchmark: runBenchmark trả về report hợp lệ", async () => {
  const scenarios = await createDefaultScenarios();
  for (const s of scenarios) s.runCount = 2; // giảm để test nhanh
  const report = await runBenchmark(scenarios);
  assert.equal(report.scenarios.length, scenarios.length);
  assert.ok(report.generatedAt);
  assert.equal(report.renderer, "pdf-overlay-renderer");
  assert.ok(report.environment.nodeVersion);
  assert.ok(report.environment.platform);
});

test("benchmark: evaluateThresholds PASS khi đạt ngưỡng", async () => {
  const scenarios = await createDefaultScenarios();
  for (const s of scenarios) s.runCount = 2;
  const report = await runBenchmark(scenarios);
  const thresholds: BenchmarkThresholds = {
    maxAvgDurationMs: 5000,
    maxP95DurationMs: 10000,
    maxAvgOutputBytes: 5000000,
    requireDeterministicSha: true,
  };
  report.thresholds = thresholds;
  const { pass, violations } = evaluateThresholds(report);
  assert.equal(pass, true);
  assert.equal(violations.length, 0);
});

test("benchmark: evaluateThresholds FAIL khi vượt ngưỡng", async () => {
  const scenarios = await createDefaultScenarios();
  for (const s of scenarios) s.runCount = 2;
  const report = await runBenchmark(scenarios);
  const thresholds: BenchmarkThresholds = {
    maxAvgDurationMs: 1, // ngưỡng rất thấp
    maxP95DurationMs: 1,
    maxAvgOutputBytes: 1,
    requireDeterministicSha: true,
  };
  report.thresholds = thresholds;
  const { pass, violations } = evaluateThresholds(report);
  assert.equal(pass, false);
  assert.ok(violations.length > 0);
});

test("benchmark: evaluateThresholds trả empty khi không có thresholds", async () => {
  const scenarios = await createDefaultScenarios();
  for (const s of scenarios) s.runCount = 2;
  const report = await runBenchmark(scenarios);
  delete report.thresholds;
  const { pass, violations } = evaluateThresholds(report);
  assert.equal(pass, true);
  assert.equal(violations.length, 0);
});
