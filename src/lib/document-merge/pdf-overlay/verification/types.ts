/**
 * PDF Overlay Verification — shared types (PR4).
 *
 * Định nghĩa cấu trúc dữ liệu cho:
 *   - Fixture: bộ dữ liệu kiểm thử xác định (deterministic)
 *   - Artifact: kết quả render (PDF + metadata)
 *   - VisualReport: báo cáo kiểm tra visual
 *   - BenchmarkResult: kết quả đo hiệu năng
 *   - ReadinessState: trạng thái sẵn sàng (gate model)
 */

import type { PdfPositionSpec } from "../types.ts";

/** Một fixture kiểm thử: template PDF + positions + fieldValues. */
export interface VerificationFixture {
  id: string;
  name: string;
  description: string;
  templatePdf: Uint8Array;
  positions: PdfPositionSpec[];
  fieldValues: Record<string, string>;
  expectedPageCount?: number;
  expectedError?: string;
  tags: string[];
}

/** Artifact từ một lần render: PDF bytes + metadata. */
export interface RenderArtifact {
  fixtureId: string;
  bytes: Uint8Array;
  sha256: string;
  pageCount: number;
  positionsDrawn: number;
  warnings: string[];
  durationMs: number;
  renderedAt: string; // ISO 8601
}

/** Báo cáo visual verification: tổng hợp nhiều fixtures. */
export interface VisualVerificationReport {
  generatedAt: string;
  renderer: string;
  fixtures: VisualFixtureReport[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
  };
  deterministic: boolean;
  warnings: string[];
}

export interface VisualFixtureReport {
  fixtureId: string;
  fixtureName: string;
  status: "PASS" | "FAIL" | "ERROR";
  artifact?: RenderArtifact;
  error?: string;
  checks: {
    rendererSucceeded: boolean;
    sha256Generated: boolean;
    pageCountMatches?: boolean;
    noUnexpectedWarnings: boolean;
    outputParseable: boolean;
  };
}

/** Kết quả benchmark một scenario. */
export interface BenchmarkScenarioResult {
  scenarioId: string;
  scenarioName: string;
  runs: BenchmarkRun[];
  summary: {
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    avgOutputBytes: number;
    avgMemoryMb: number | null;
    deterministicSha: boolean;
  };
}

export interface BenchmarkRun {
  runIndex: number;
  durationMs: number;
  outputBytes: number;
  sha256: string;
  memoryMb: number | null;
}

/** Báo cáo benchmark tổng hợp. */
export interface BenchmarkReport {
  generatedAt: string;
  renderer: string;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
  };
  scenarios: BenchmarkScenarioResult[];
  thresholds?: BenchmarkThresholds;
}

export interface BenchmarkThresholds {
  maxAvgDurationMs: number;
  maxP95DurationMs: number;
  maxAvgOutputBytes: number;
  requireDeterministicSha: boolean;
}

/** Trạng thái sẵn sàng của PDF Overlay (gate model). */
export type ReadinessGate =
  | "INFRASTRUCTURE_READY"
  | "PDF_OVERLAY_IMPLEMENTED"
  | "VISUAL_GATE_PENDING"
  | "VISUAL_GATE_APPROVED"
  | "BENCHMARK_GATE_PENDING"
  | "BENCHMARK_GATE_APPROVED"
  | "STAGING_E2E_1_RECORD"
  | "STAGING_E2E_10_RECORD"
  | "ACTIVATION_ALLOWED";

export interface ReadinessState {
  currentGate: ReadinessGate;
  gates: Record<ReadinessGate, GateStatus>;
  canProceedToActivation: boolean;
  notes: string[];
}

export interface GateStatus {
  status: "PENDING" | "PASS" | "FAIL" | "BLOCKED";
  reason?: string;
  verifiedAt?: string;
  verifiedBy?: string;
}

/**
 * Báo cáo máy đọc được (machine-readable evidence) của 1 lần staging E2E
 * (PR5) — dùng để cập nhật gate STAGING_E2E_1_RECORD / STAGING_E2E_10_RECORD.
 * KHÔNG bao giờ chứa secret / PII — chỉ jobId, counts, sha256, storage IDs,
 * history counts, worker revision (public)...
 */
export interface StagingE2EReport {
  generatedAt: string;
  recordCount: 1 | 10;
  status: "PASS" | "FAIL";
  jobId: string;
  itemCount: number;
  completed: number;
  failed: number;
  retryCount: number;
  renderDurationMs: number;
  storageIds: string[];
  sha256s: string[];
  historyCount: number;
  workerRevision: string | null;
  outputUrls: string[];
  productionIsolation: {
    engineDefault: string;
    activationAllowed: false;
    productionMutated: false;
    piiInFixtures: false;
  };
}

/** Manifest của artifact (để tracking/review). */
export interface ArtifactManifest {
  generatedAt: string;
  artifacts: ArtifactEntry[];
  totalBytes: number;
  renderer: string;
  environment: string;
}

export interface ArtifactEntry {
  fixtureId: string;
  filename: string;
  sha256: string;
  bytes: number;
  pageCount: number;
  tags: string[];
}
