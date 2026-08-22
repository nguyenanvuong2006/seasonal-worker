/**
 * PDF Overlay Verification — readiness gate state model (PR4).
 *
 * Quản lý trạng thái sẵn sàng của PDF Overlay qua các gate:
 *   INFRASTRUCTURE_READY → PDF_OVERLAY_IMPLEMENTED → VISUAL_GATE_PENDING →
 *   VISUAL_GATE_APPROVED → BENCHMARK_GATE_PENDING → BENCHMARK_GATE_APPROVED →
 *   ACTIVATION_ALLOWED
 *
 * VISUAL_GATE và BENCHMARK_GATE KHÔNG tự động PASS — cần operator review.
 * KHÔNG có gate nào tự kích hoạt PDF Overlay.
 */

import type {
  ReadinessGate,
  ReadinessState,
  GateStatus,
  VisualVerificationReport,
  BenchmarkReport,
} from "./types.ts";

const GATE_ORDER: readonly ReadinessGate[] = [
  "INFRASTRUCTURE_READY",
  "PDF_OVERLAY_IMPLEMENTED",
  "VISUAL_GATE_PENDING",
  "VISUAL_GATE_APPROVED",
  "BENCHMARK_GATE_PENDING",
  "BENCHMARK_GATE_APPROVED",
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

  // canProceedToActivation chỉ true khi BENCHMARK_GATE_APPROVED đã PASS
  updated.canProceedToActivation =
    updated.gates["BENCHMARK_GATE_APPROVED"].status === "PASS" &&
    updated.gates["VISUAL_GATE_APPROVED"].status === "PASS";

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
 * Tính ReadinessState từ visual + benchmark reports.
 * VISUAL_GATE và BENCHMARK_GATE KHÔNG tự động PASS.
 */
export function computeReadinessState(
  visualReport: VisualVerificationReport | null,
  benchmarkReport: BenchmarkReport | null,
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

  // ACTIVATION_ALLOWED: chỉ khi cả 2 gate đều APPROVED (PASS)
  if (
    state.gates["VISUAL_GATE_APPROVED"].status === "PASS" &&
    state.gates["BENCHMARK_GATE_APPROVED"].status === "PASS"
  ) {
    state = updateGate(state, "ACTIVATION_ALLOWED", "PASS", "Both gates approved by operator.");
    state.canProceedToActivation = true;
  } else {
    state = updateGate(
      state,
      "ACTIVATION_ALLOWED",
      "BLOCKED",
      "VISUAL_GATE and/or BENCHMARK_GATE chưa được operator APPROVE.",
    );
    state.canProceedToActivation = false;
  }

  return state;
}
