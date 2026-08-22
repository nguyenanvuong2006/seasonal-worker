#!/usr/bin/env node
/**
 * PDF Overlay Benchmark CLI (PR4).
 *
 * Đo hiệu năng renderer pdf-lib:
 *   - cold/warm render
 *   - single-page / multi-page
 *   - small / representative field count
 *   - repeated renders
 *   - output PDF size
 *   - execution duration
 *   - memory usage
 *   - deterministic SHA behavior
 *
 * Usage:
 *   cd worker && npm run benchmark:pdf-overlay
 *   cd worker && node scripts/pdf-overlay-benchmark.mjs [--out <dir>]
 *
 * Output:
 *   <out>/benchmark.json       — machine-readable benchmark report
 *
 * KHÔNG dùng dữ liệu Production. KHÔNG kích hoạt PDF Overlay.
 * Thresholds KHÔNG tự động PASS — báo cáo để operator review.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createDefaultScenarios, runBenchmark, evaluateThresholds } from "../../src/lib/document-merge/pdf-overlay/verification/benchmark-harness.ts";
import { assertVerificationSafe } from "../../src/lib/document-merge/pdf-overlay/verification/production-isolation.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const outDir = arg("--out", join(ROOT, "docs", "pdf-overlay-benchmark"));
const runsPerScenario = Number(arg("--runs", "5"));

console.log("⚡ PDF Overlay Benchmark Harness\n");

// Guard: kiểm tra an toàn trước khi chạy
const safety = assertVerificationSafe();
if (!safety.safe) {
  console.error(`❌ BLOCKED: ${safety.reason}`);
  process.exit(1);
}

console.log("✅ Safety checks passed\n");

// Tạo scenarios
console.log("📦 Creating benchmark scenarios...");
const scenarios = await createDefaultScenarios();
for (const s of scenarios) {
  s.runCount = runsPerScenario;
}
console.log(`   → ${scenarios.length} scenarios created (${runsPerScenario} runs each)\n`);

// Chạy benchmark
console.log("🏃 Running benchmark...");
const report = await runBenchmark(scenarios);
console.log(`   → Benchmark complete\n`);

// Tạo output directory
mkdirSync(outDir, { recursive: true });

// Lưu report
const reportPath = join(outDir, "benchmark.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));

// In kết quả
console.log("📊 Results:\n");
console.log("Scenario".padEnd(40) + "Avg (ms)".padEnd(10) + "P95 (ms)".padEnd(10) + "Size (KB)".padEnd(10) + "Deterministic");
console.log("-".repeat(80));

for (const scenario of report.scenarios) {
  const name = scenario.scenarioName.slice(0, 38);
  const avg = String(scenario.summary.avgDurationMs);
  const p95 = String(scenario.summary.p95DurationMs);
  const size = String(Math.round(scenario.summary.avgOutputBytes / 1024));
  const det = scenario.summary.deterministicSha ? "✅" : "❌";

  console.log(
    name.padEnd(40) + avg.padEnd(10) + p95.padEnd(10) + size.padEnd(10) + det
  );
}

console.log(`\n📁 Report saved to: ${outDir}/benchmark.json`);

console.log(`\n🌍 Environment:`);
console.log(`   Node: ${report.environment.nodeVersion}`);
console.log(`   Platform: ${report.environment.platform}`);
console.log(`   Arch: ${report.environment.arch}`);

// Kiểm tra deterministic
const nonDeterministic = report.scenarios.filter((s) => !s.summary.deterministicSha);
if (nonDeterministic.length > 0) {
  console.log(`\n❌ BENCHMARK_GATE: FAIL`);
  console.log(`   ${nonDeterministic.length} scenario(s) có SHA không deterministic.`);
  process.exit(1);
}

// Nếu có thresholds, kiểm tra
if (report.thresholds) {
  const { pass, violations } = evaluateThresholds(report);
  if (!pass) {
    console.log(`\n❌ BENCHMARK_GATE: FAIL (vượt thresholds)`);
    for (const v of violations) {
      console.log(`   - ${v}`);
    }
    process.exit(1);
  }
}

console.log(`\n⏸️  BENCHMARK_GATE: PENDING_OPERATOR_REVIEW`);
console.log(`   Review benchmark results then update readiness state manually.`);
console.log(`   No thresholds defined — operator should set operational requirements.`);
