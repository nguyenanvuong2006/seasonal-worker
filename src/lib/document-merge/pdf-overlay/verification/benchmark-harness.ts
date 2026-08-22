/**
 * PDF Overlay Verification — benchmark harness (PR4).
 *
 * Đo hiệu năng renderer pdf-lib (KHÔNG Playwright/Chromium):
 *   - cold/warm render
 *   - single-page / multi-page
 *   - small / representative field count
 *   - repeated renders
 *   - output PDF size
 *   - execution duration
 *   - memory usage (process.memoryUsage)
 *   - deterministic SHA behavior
 *
 * KHÔNG dùng dữ liệu Production. Thresholds KHÔNG tự PASS — báo cáo để
 * operator review, hoặc so sánh với ngưỡng đã duyệt trước đó (nếu có).
 */

import { PDFDocument } from "pdf-lib";

import { A4_HEIGHT_PT, A4_WIDTH_PT } from "../geometry.ts";
import type { PdfPositionSpec } from "../types.ts";
import { renderPdfOverlay } from "../renderer.ts";
import { readEmbeddedFontBytes } from "../vietnamese-font.ts";
import type {
  BenchmarkReport,
  BenchmarkRun,
  BenchmarkScenarioResult,
  BenchmarkThresholds,
} from "./types.ts";

const RENDERER_NAME = "pdf-overlay-renderer";

/** Tạo blank template pageCount trang A4. */
async function makeTemplate(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
  return doc.save({ useObjectStreams: true });
}

/** Helper: tạo N text positions trên 1 trang. */
function makeTextPositions(count: number, pageNumber = 1): PdfPositionSpec[] {
  const positions: PdfPositionSpec[] = [];
  for (let i = 0; i < count; i++) {
    positions.push({
      placeholder: `field_${i}`,
      pageNumber,
      x: 50,
      y: 750 - (i % 30) * 24,
      width: 200,
      height: 18,
      type: "TEXT",
      fontSize: 10,
    });
  }
  return positions;
}

/** Helper: tạo fieldValues cho N fields. */
function makeFieldValues(count: number): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    values[`field_${i}`] = `Giá trị ${i} — Bùi Nguyễn Phương Vy`;
  }
  return values;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface BenchmarkScenario {
  id: string;
  name: string;
  templatePdf: Uint8Array;
  positions: PdfPositionSpec[];
  fieldValues: Record<string, string>;
  runCount: number;
}

/** Tạo các scenario benchmark mặc định. */
export async function createDefaultScenarios(): Promise<BenchmarkScenario[]> {
  const template1 = await makeTemplate(1);
  const template3 = await makeTemplate(3);
  const template10 = await makeTemplate(10);

  return [
    {
      id: "single-page-1-field",
      name: "Single page, 1 field (cold/warm)",
      templatePdf: template1,
      positions: makeTextPositions(1),
      fieldValues: makeFieldValues(1),
      runCount: 10,
    },
    {
      id: "single-page-10-fields",
      name: "Single page, 10 fields",
      templatePdf: template1,
      positions: makeTextPositions(10),
      fieldValues: makeFieldValues(10),
      runCount: 10,
    },
    {
      id: "single-page-30-fields",
      name: "Single page, 30 fields (representative)",
      templatePdf: template1,
      positions: makeTextPositions(30),
      fieldValues: makeFieldValues(30),
      runCount: 10,
    },
    {
      id: "multi-page-3",
      name: "Multi-page (3 pages, 3 fields)",
      templatePdf: template3,
      positions: [
        ...makeTextPositions(1, 1),
        ...makeTextPositions(1, 2).map((p) => ({ ...p, placeholder: `p2_${p.placeholder}` })),
        ...makeTextPositions(1, 3).map((p) => ({ ...p, placeholder: `p3_${p.placeholder}` })),
      ],
      fieldValues: {
        ...makeFieldValues(1),
        p2_field_0: "Trang 2 — giá trị",
        p3_field_0: "Trang 3 — giá trị",
      },
      runCount: 10,
    },
    {
      id: "multi-page-10",
      name: "Multi-page (10 pages, 30 fields)",
      templatePdf: template10,
      positions: Array.from({ length: 10 }, (_, page) =>
        makeTextPositions(3, page + 1).map((p) => ({
          ...p,
          placeholder: `pg${page}_${p.placeholder}`,
        })),
      ).flat(),
      fieldValues: Object.fromEntries(
        Array.from({ length: 10 }, (_, page) =>
          Object.entries(makeFieldValues(3)).map(([k, v]) => [`pg${page}_${k}`, v]),
        ).flat(),
      ),
      runCount: 5,
    },
  ];
}

/** Chạy benchmark 1 scenario. */
export async function runScenario(
  scenario: BenchmarkScenario,
  fontBytes: Uint8Array,
): Promise<BenchmarkScenarioResult> {
  const runs: BenchmarkRun[] = [];

  for (let i = 0; i < scenario.runCount; i++) {
    const memBefore = process.memoryUsage();
    const startedAt = Date.now();

    const result = await renderPdfOverlay(
      scenario.templatePdf,
      scenario.positions,
      scenario.fieldValues,
      { fontBytes, subsetFont: true },
    );

    const durationMs = Date.now() - startedAt;
    const memAfter = process.memoryUsage();
    const memoryMb = Math.round(((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)) * 100) / 100;

    runs.push({
      runIndex: i,
      durationMs,
      outputBytes: result.bytes.byteLength,
      sha256: result.sha256,
      memoryMb,
    });
  }

  const durations = runs.map((r) => r.durationMs).sort((a, b) => a - b);
  const outputBytes = runs.map((r) => r.outputBytes);
  const memories = runs.map((r) => r.memoryMb).filter((m) => m !== null);
  const shas = new Set(runs.map((r) => r.sha256));

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    runs,
    summary: {
      avgDurationMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      p50DurationMs: percentile(durations, 50),
      p95DurationMs: percentile(durations, 95),
      avgOutputBytes: Math.round(outputBytes.reduce((a, b) => a + b, 0) / outputBytes.length),
      avgMemoryMb: memories.length > 0
        ? Math.round((memories.reduce((a, b) => a + b, 0) / memories.length) * 100) / 100
        : null,
      deterministicSha: shas.size === 1,
    },
  };
}

/** Chạy benchmark tất cả scenarios. */
export async function runBenchmark(
  scenarios?: BenchmarkScenario[],
  thresholds?: BenchmarkThresholds,
): Promise<BenchmarkReport> {
  const fontBytes = readEmbeddedFontBytes();
  const allScenarios = scenarios ?? (await createDefaultScenarios());

  const results: BenchmarkScenarioResult[] = [];
  for (const scenario of allScenarios) {
    const result = await runScenario(scenario, fontBytes);
    results.push(result);
  }

  return {
    generatedAt: new Date().toISOString(),
    renderer: RENDERER_NAME,
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    scenarios: results,
    thresholds,
  };
}

/** Kiểm tra benchmark report có đạt thresholds không (nếu có). */
export function evaluateThresholds(
  report: BenchmarkReport,
): { pass: boolean; violations: string[] } {
  if (!report.thresholds) {
    return { pass: true, violations: [] };
  }

  const violations: string[] = [];
  const t = report.thresholds;

  for (const scenario of report.scenarios) {
    if (scenario.summary.avgDurationMs > t.maxAvgDurationMs) {
      violations.push(
        `${scenario.scenarioId}: avgDurationMs=${scenario.summary.avgDurationMs} > max=${t.maxAvgDurationMs}`,
      );
    }
    if (scenario.summary.p95DurationMs > t.maxP95DurationMs) {
      violations.push(
        `${scenario.scenarioId}: p95DurationMs=${scenario.summary.p95DurationMs} > max=${t.maxP95DurationMs}`,
      );
    }
    if (scenario.summary.avgOutputBytes > t.maxAvgOutputBytes) {
      violations.push(
        `${scenario.scenarioId}: avgOutputBytes=${scenario.summary.avgOutputBytes} > max=${t.maxAvgOutputBytes}`,
      );
    }
    if (t.requireDeterministicSha && !scenario.summary.deterministicSha) {
      violations.push(`${scenario.scenarioId}: SHA không deterministic`);
    }
  }

  return { pass: violations.length === 0, violations };
}
