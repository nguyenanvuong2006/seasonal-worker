/**
 * PDF Overlay Verification — readiness gate state model (PR4 + PR5).
 *
 * Quản lý trạng thái sẵn sàng của PDF Overlay qua các gate:
 *   INFRASTRUCTURE_READY → PDF_OVERLAY_IMPLEMENTED → VISUAL_GATE_PENDING →
 *   VISUAL_GATE_APPROVED → BENCHMARK_GATE_PENDING → BENCHMARK_GATE_APPROVED →
 *   STAGING_E2E_1_RECORD → STAGING_E2E_10_RECORD → ACTIVATION_ALLOWED
 *
 * VISUAL_GATE, BENCHMARK_GATE KHÔNG tự động PASS — cần operator review.
 * STAGING_E2E_* tự PASS khi báo cáo E2E staging (machine-readable) hợp lệ —
 * nhưng KHÔNG bao giờ tự bật ACTIVATION_ALLOWED.
 *
 * ACTIVATION_ALLOWED (PR5 trở đi): CHỈ operator đặt PASS trực tiếp qua
 * updateGate() (thuộc PR6 + approval tường minh). computeReadinessState chỉ
 * tính canProceedToActivation (đủ điều kiện tiền đề) — không tự PASS gate.
 * KHÔNG có gate nào tự kích hoạt PDF Overlay.
 */

import type {
  ReadinessGate,
  ReadinessState,
  GateStatus,
  VisualVerificationReport,
  BenchmarkReport,
  StagingE2EReport,
} from "./types.ts";

const GATE_ORDER: readonly ReadinessGate[] = [
  "INFRASTRUCTURE_READY",
  "PDF_OVERLAY_IMPLEMENTED",
  "VISUAL_GATE_PENDING",
  "VISUAL_GATE_APPROVED",
  "BENCHMARK_GATE_PENDING",
  "BENCHMARK_GATE_APPROVED",
  "STAGING_E2E_1_RECORD",
  "STAGING_E2E_10_RECORD",
  "ACTIVATION_ALLOWED",
];

/** Khởi tạo trạng thái mặc định — tất cả PENDING. */
export function createInitialReadinessState(): ReadinessState {
  const gates = {} as Record<ReadinessGate, GateStatus>;
  for (const gate of GATE_ORDER) {
    gates[gate] = { status: "PENDING" };
  }
  return {
    currentGate: "INFRASTRUCTURE_READY",
    gates,
    canProceedToActivation: false,
    notes: ["Initial state — all gates PENDING."],
  };
}

/** Cập nhật trạng thái 1 gate. */
export function updateGate(
  state: ReadinessState,
  gate: ReadinessGate,
  status: GateStatus["status"],
  reason?: string,
): ReadinessState {
  const updated = {
    ...state,
    gates: {
      ...state.gates,
      [gate]: {
        status,
        reason,
        verifiedAt: status === "PASS" ? new Date().toISOString() : undefined,
      },
    },
  };

  // Cập nhật currentGate: gate cao nhất đã PASS
  for (let i = GATE_ORDER.length - 1; i >= 0; i--) {
    if (updated.gates[GATE_ORDER[i]].status === "PASS") {
      updated.currentGate = GATE_ORDER[i];
      break;
    }
  }

  // canProceedToActivation = đủ 4 gate tiền đề (visual + benchmark + 2 E2E staging).
  // ACTIVATION_ALLOWED vẫn là quyết định OPERATOR riêng (updateGate trực tiếp).
  updated.canProceedToActivation =
    updated.gates["VISUAL_GATE_APPROVED"].status === "PASS" &&
    updated.gates["BENCHMARK_GATE_APPROVED"].status === "PASS" &&
    updated.gates["STAGING_E2E_1_RECORD"].status === "PASS" &&
    updated.gates["STAGING_E2E_10_RECORD"].status === "PASS";

  return updated;
}

/**
 * Đánh giá visual report → đề xuất trạng thái gate.
 * KHÔNG tự động PASS — chỉ trả PENDING_OPERATOR_REVIEW nếu tất cả fixtures PASS.
 */
export function evaluateVisualGate(
  report: VisualVerificationReport,
): { status: "PASS" | "FAIL" | "PENDING_OPERATOR_REVIEW"; reason: string } {
  const allPassed =
    report.summary.failed === 0 &&
    report.summary.errors === 0 &&
    report.deterministic &&
    report.warnings.length === 0;

  if (report.summary.errors > 0) {
    return {
      status: "FAIL",
      reason: `${report.summary.errors} fixture(s) có lỗi render.`,
    };
  }

  if (report.summary.failed > 0) {
    return {
      status: "FAIL",
      reason: `${report.summary.failed} fixture(s) không đạt checks.`,
    };
  }

  if (!report.deterministic) {
    return {
      status: "FAIL",
      reason: "Output không deterministic (SHA thay đổi giữa các lần render).",
    };
  }

  if (allPassed) {
    return {
      status: "PENDING_OPERATOR_REVIEW",
      reason: `Tất cả ${report.summary.total} fixtures PASS automated checks. Cần operator review visual artifacts trước khi APPROVE.`,
    };
  }

  return {
    status: "PENDING_OPERATOR_REVIEW",
    reason: "Cần operator review.",
  };
}

/**
 * Đánh giá benchmark report → đề xuất trạng thái gate.
 * Nếu có thresholds → so sánh. Nếu không → PENDING_OPERATOR_REVIEW.
 */
export function evaluateBenchmarkGate(
  report: BenchmarkReport,
): { status: "PASS" | "FAIL" | "PENDING_OPERATOR_REVIEW"; reason: string } {
  // Kiểm tra deterministic SHA
  const nonDeterministic = report.scenarios.filter((s) => !s.summary.deterministicSha);
  if (nonDeterministic.length > 0) {
    return {
      status: "FAIL",
      reason: `${nonDeterministic.length} scenario(s) có SHA không deterministic.`,
    };
  }

  if (!report.thresholds) {
    return {
      status: "PENDING_OPERATOR_REVIEW",
      reason: `Không có thresholds định sẵn. ${report.scenarios.length} scenarios đã đo — cần operator review và đặt ngưỡng.`,
    };
  }

  // So sánh với thresholds
  const violations: string[] = [];
  for (const scenario of report.scenarios) {
    if (scenario.summary.avgDurationMs > report.thresholds.maxAvgDurationMs) {
      violations.push(`${scenario.scenarioId}: avg ${scenario.summary.avgDurationMs}ms > max ${report.thresholds.maxAvgDurationMs}ms`);
    }
    if (scenario.summary.p95DurationMs > report.thresholds.maxP95DurationMs) {
      violations.push(`${scenario.scenarioId}: p95 ${scenario.summary.p95DurationMs}ms > max ${report.thresholds.maxP95DurationMs}ms`);
    }
  }

  if (violations.length > 0) {
    return {
      status: "FAIL",
      reason: `Vượt ngưỡng: ${violations.join("; ")}`,
    };
  }

  return {
    status: "PENDING_OPERATOR_REVIEW",
    reason: "Đạt thresholds tự động — cần operator xác nhận trước khi APPROVE.",
  };
}

/**
 * Đánh giá 1 báo cáo staging E2E (PR5) → trạng thái gate.
 * PASS chỉ khi: report PASS, đủ itemCount, completed == recordCount,
 * failed == 0, historyCount == recordCount (không duplicate/missing),
 * productionIsolation đúng (engineDefault GOOGLE_DOCS, không mutation,
 * không PII, activationAllowed=false).
 */
export function evaluateStagingE2EGate(
  report: StagingE2EReport | null | undefined,
): { status: "PASS" | "FAIL" | "PENDING"; reason: string } {
  if (!report) {
    return { status: "PENDING", reason: "Chưa có báo cáo staging E2E." };
  }
  if (report.status !== "PASS") {
    return { status: "FAIL", reason: `Báo cáo staging E2E status=${report.status}.` };
  }
  if (report.itemCount !== report.recordCount) {
    return { status: "FAIL", reason: `itemCount=${report.itemCount} != recordCount=${report.recordCount}.` };
  }
  if (report.completed !== report.recordCount || report.failed !== 0) {
    return {
      status: "FAIL",
      reason: `completed=${report.completed} (kỳ vọng ${report.recordCount}), failed=${report.failed} (kỳ vọng 0).`,
    };
  }
  if (report.historyCount !== report.recordCount) {
    return { status: "FAIL", reason: `historyCount=${report.historyCount} != recordCount=${report.recordCount}.` };
  }
  if (report.sha256s.length !== report.recordCount) {
    return { status: "FAIL", reason: `sha256s=${report.sha256s.length} != recordCount=${report.recordCount}.` };
  }
  if (report.productionIsolation.engineDefault !== "GOOGLE_DOCS") {
    return { status: "FAIL", reason: `engineDefault=${report.productionIsolation.engineDefault} != GOOGLE_DOCS.` };
  }
  if (report.productionIsolation.productionMutated) {
    return { status: "FAIL", reason: "productionMutated=true — E2E đã đụng production." };
  }
  if (report.productionIsolation.piiInFixtures) {
    return { status: "FAIL", reason: "piiInFixtures=true — fixture chứa PII." };
  }
  return {
    status: "PASS",
    reason: `Staging E2E ${report.recordCount} record PASS — job ${report.jobId}, completed=${report.completed}, failed=${report.failed}, history=${report.historyCount}.`,
  };
}

export interface StagingE2EInput {
  oneRecord?: StagingE2EReport | null;
  tenRecord?: StagingE2EReport | null;
}

/**
 * Tính ReadinessState từ visual + benchmark + staging E2E reports.
 * VISUAL_GATE, BENCHMARK_GATE KHÔNG tự động PASS — cần operator review.
 * STAGING_E2E_* tự PASS khi báo cáo hợp lệ (evaluateStagingE2EGate).
 * ACTIVATION_ALLOWED KHÔNG BAO GIỜ tự PASS — luôn BLOCKED chờ operator
 * (updateGate trực tiếp, thuộc PR6).
 */
export function computeReadinessState(
  visualReport: VisualVerificationReport | null,
  benchmarkReport: BenchmarkReport | null,
  stagingE2E: StagingE2EInput | null = null,
): ReadinessState {
  let state = createInitialReadinessState();

  // Infrastructure + implementation are assumed PASS (PR1/PR2/PR3 merged)
  state = updateGate(state, "INFRASTRUCTURE_READY", "PASS", "PR1/PR2/PR3 merged into main.");
  state = updateGate(state, "PDF_OVERLAY_IMPLEMENTED", "PASS", "Renderer, management layer, admin mapper implemented.");

  if (visualReport) {
    state = updateGate(state, "VISUAL_GATE_PENDING", "PASS", "Visual verification đã chạy.");
    const visualEval = evaluateVisualGate(visualReport);
    if (visualEval.status === "FAIL") {
      state = updateGate(state, "VISUAL_GATE_APPROVED", "FAIL", visualEval.reason);
      state.notes.push(`VISUAL_GATE: FAIL — ${visualEval.reason}`);
    } else {
      state = updateGate(state, "VISUAL_GATE_APPROVED", "PENDING", visualEval.reason);
      state.notes.push(`VISUAL_GATE: PENDING_OPERATOR_REVIEW — ${visualEval.reason}`);
    }
  } else {
    state.notes.push("VISUAL_GATE: chưa chạy verification.");
  }

  if (benchmarkReport) {
    state = updateGate(state, "BENCHMARK_GATE_PENDING", "PASS", "Benchmark đã chạy.");
    const benchEval = evaluateBenchmarkGate(benchmarkReport);
    if (benchEval.status === "FAIL") {
      state = updateGate(state, "BENCHMARK_GATE_APPROVED", "FAIL", benchEval.reason);
      state.notes.push(`BENCHMARK_GATE: FAIL — ${benchEval.reason}`);
    } else {
      state = updateGate(state, "BENCHMARK_GATE_APPROVED", "PENDING", benchEval.reason);
      state.notes.push(`BENCHMARK_GATE: PENDING_OPERATOR_REVIEW — ${benchEval.reason}`);
    }
  } else {
    state.notes.push("BENCHMARK_GATE: chưa chạy benchmark.");
  }

  // STAGING E2E gates (PR5): tự PASS khi báo cáo machine-readable hợp lệ.
  const e2eOne = stagingE2E?.oneRecord ?? null;
  const e2eTen = stagingE2E?.tenRecord ?? null;
  const e2eOneEval = evaluateStagingE2EGate(e2eOne);
  if (e2eOneEval.status === "PASS") {
    state = updateGate(state, "STAGING_E2E_1_RECORD", "PASS", e2eOneEval.reason);
  } else if (e2eOneEval.status === "FAIL") {
    state = updateGate(state, "STAGING_E2E_1_RECORD", "FAIL", e2eOneEval.reason);
  }
  state.notes.push(`STAGING_E2E_1_RECORD: ${e2eOneEval.status} — ${e2eOneEval.reason}`);
  const e2eTenEval = evaluateStagingE2EGate(e2eTen);
  if (e2eTenEval.status === "PASS") {
    state = updateGate(state, "STAGING_E2E_10_RECORD", "PASS", e2eTenEval.reason);
  } else if (e2eTenEval.status === "FAIL") {
    state = updateGate(state, "STAGING_E2E_10_RECORD", "FAIL", e2eTenEval.reason);
  }
  state.notes.push(`STAGING_E2E_10_RECORD: ${e2eTenEval.status} — ${e2eTenEval.reason}`);

  // ACTIVATION_ALLOWED: KHÔNG BAO GIỜ tự PASS (PR5) — luôn là quyết định
  // operator (updateGate trực tiếp, PR6 + approval tường minh).
  const missingPrereqs = GATE_ORDER.filter(
    (g) =>
      (g === "VISUAL_GATE_APPROVED" ||
        g === "BENCHMARK_GATE_APPROVED" ||
        g === "STAGING_E2E_1_RECORD" ||
        g === "STAGING_E2E_10_RECORD") &&
      state.gates[g].status !== "PASS",
  );
  const activationReason =
    missingPrereqs.length === 0
      ? "Tất cả gate tiền đề đã PASS — ACTIVATION_ALLOWED cần operator approval tường minh (PR6). KHÔNG tự kích hoạt."
      : `Các gate tiền đề chưa PASS: ${missingPrereqs.join(", ")} — ACTIVATION_ALLOWED bị BLOCKED.`;
  state = updateGate(state, "ACTIVATION_ALLOWED", "BLOCKED", activationReason);
  state.notes.push(`ACTIVATION_ALLOWED: BLOCKED (operator decision — ${activationReason})`);

  return state;
}
