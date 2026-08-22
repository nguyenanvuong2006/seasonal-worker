#!/usr/bin/env node
/**
 * PDF Overlay Visual Verification CLI (PR4).
 *
 * Chạy visual verification harness, tạo artifacts (PDF + report) để operator review.
 * KHÔNG tự động PASS visual — chỉ tạo artifacts và automated checks.
 *
 * Usage:
 *   cd worker && npm run verify:pdf-overlay
 *   cd worker && node scripts/pdf-overlay-visual-verify.mjs [--out <dir>]
 *
 * Output:
 *   <out>/report.json          — machine-readable verification report
 *   <out>/fixtures/<id>.pdf    — rendered PDF cho từng fixture
 *   <out>/manifest.json        — artifact manifest
 *
 * KHÔNG dùng dữ liệu Production. KHÔNG kích hoạt PDF Overlay.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { generateAllFixtures } from "../../src/lib/document-merge/pdf-overlay/verification/fixtures.ts";
import { runVisualVerification, hashReport } from "../../src/lib/document-merge/pdf-overlay/verification/visual-harness.ts";
import { assertVerificationSafe, createNonProductionMarker } from "../../src/lib/document-merge/pdf-overlay/verification/production-isolation.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const outDir = arg("--out", join(ROOT, "docs", "pdf-overlay-verification"));

console.log("🔍 PDF Overlay Visual Verification Harness\n");

// Guard: kiểm tra an toàn trước khi chạy
const safety = assertVerificationSafe();
if (!safety.safe) {
  console.error(`❌ BLOCKED: ${safety.reason}`);
  process.exit(1);
}

console.log("✅ Safety checks passed\n");

// Tạo fixtures
console.log("📦 Generating fixtures...");
const fixtures = await generateAllFixtures();
console.log(`   → ${fixtures.length} fixtures created\n`);

// Chạy verification
console.log("🎨 Running visual verification...");
const report = await runVisualVerification(fixtures);
console.log(`   → ${report.summary.passed}/${report.summary.total} fixtures PASS\n`);

// Tạo output directory
mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "fixtures"), { recursive: true });

// Lưu artifacts (PDF files)
console.log("💾 Saving artifacts...");
const manifest = {
  generatedAt: new Date().toISOString(),
  artifacts: [],
  totalBytes: 0,
  renderer: report.renderer,
  environment: "staging-verification",
  marker: createNonProductionMarker(),
};

for (const fixtureReport of report.fixtures) {
  if (fixtureReport.artifact) {
    const filename = `${fixtureReport.fixtureId}.pdf`;
    const filepath = join(outDir, "fixtures", filename);
    writeFileSync(filepath, fixtureReport.artifact.bytes);

    manifest.artifacts.push({
      fixtureId: fixtureReport.fixtureId,
      filename: `fixtures/${filename}`,
      sha256: fixtureReport.artifact.sha256,
      bytes: fixtureReport.artifact.bytes.byteLength,
      pageCount: fixtureReport.artifact.pageCount,
      tags: fixtures.find((f) => f.id === fixtureReport.fixtureId)?.tags ?? [],
    });

    manifest.totalBytes += fixtureReport.artifact.bytes.byteLength;
  }
}

// Lưu report
const reportPath = join(outDir, "report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));

// Lưu manifest
const manifestPath = join(outDir, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// Lưu report hash
const reportHash = hashReport(report);
writeFileSync(join(outDir, "report.sha256"), reportHash);

console.log(`\n📊 Results:`);
console.log(`   Total fixtures: ${report.summary.total}`);
console.log(`   Passed: ${report.summary.passed}`);
console.log(`   Failed: ${report.summary.failed}`);
console.log(`   Errors: ${report.summary.errors}`);
console.log(`   Deterministic: ${report.deterministic ? "✅" : "❌"}`);

if (report.warnings.length > 0) {
  console.log(`\n⚠️  Warnings:`);
  for (const warning of report.warnings) {
    console.log(`   - ${warning}`);
  }
}

console.log(`\n📁 Artifacts saved to: ${outDir}`);
console.log(`   - report.json`);
console.log(`   - manifest.json`);
console.log(`   - report.sha256`);
console.log(`   - fixtures/*.pdf`);

console.log(`\n🔐 Report SHA-256: ${reportHash}`);

console.log(`\n⏭️  NEXT STEP: Operator must manually review PDF artifacts in ${outDir}/fixtures/`);
console.log(`   Check for:`);
console.log(`   - Vietnamese glyph rendering`);
console.log(`   - Text alignment (horizontal + vertical)`);
console.log(`   - Multi-line wrapping`);
console.log(`   - Checkbox rendering`);
console.log(`   - Page boundaries`);
console.log(`   - No clipping or overflow`);

if (report.summary.failed > 0 || report.summary.errors > 0 || !report.deterministic) {
  console.log(`\n❌ VISUAL_GATE: FAIL`);
  process.exit(1);
} else {
  console.log(`\n⏸️  VISUAL_GATE: PENDING_OPERATOR_REVIEW`);
  console.log(`   Review artifacts then update readiness state manually.`);
}
