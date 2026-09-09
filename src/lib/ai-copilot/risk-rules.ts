/**
 * AI COPILOT — deterministic, rule-based department risk classifier
 * (Phase 2 "AI Analyst"). Pure (no "server-only", no DB) — the tool that
 * calls this gathers real signals from the DB and passes them in; DeepSeek
 * only explains the result, never computes or overrides it (mission: "Do
 * NOT build opaque ML forecasting yet... The rules must be deterministic
 * and testable").
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export type RiskSignals = {
  /** Realtime Workforce Request gap (max(0, Request − CurrentWorkforce)), summed for the department — see workforce-request-kpi.ts computeRequestKpi. */
  currentGap: number;
  /** Total requested headcount the gap is measured against — used to express currentGap as a ratio, never as a lone absolute number. */
  totalRequested: number;
  /** Employment sessions ended (any endReason) in the trailing lookback window (e.g. last 30 days). */
  recentExits: number;
  /** workforce_movements TRANSFER rows with this department as fromDeptId in the trailing lookback window. */
  recentMovementOutflow: number;
  /** Recruitment requests still PENDING/PROCESSING with totalBalance > 0 (open, unfilled). */
  openRecruitmentGapCount: number;
  /** Workforce Request rows whose expectedDate falls within the next lookahead window (e.g. next 14 days) and are not yet fulfilled. */
  upcomingDemandCount: number;
};

export type RiskAssessment = {
  level: RiskLevel;
  score: number;
  factors: string[];
};

const GAP_RATIO_HIGH = 0.25; // gap >= 25% of requested headcount
const GAP_RATIO_MEDIUM = 0.1;

/**
 * Deterministic scoring — each signal contributes at most 1 point (2 for a
 * severe current gap), capped, then mapped to LOW/MEDIUM/HIGH. Every
 * contributing factor is returned as an explicit, traceable string so the
 * UI/model never needs to reverse-engineer why a department was flagged.
 */
export function classifyDepartmentRisk(signals: RiskSignals): RiskAssessment {
  let score = 0;
  const factors: string[] = [];

  const gapRatio = signals.totalRequested > 0 ? signals.currentGap / signals.totalRequested : signals.currentGap > 0 ? 1 : 0;
  if (signals.currentGap > 0) {
    if (gapRatio >= GAP_RATIO_HIGH) {
      score += 2;
      factors.push(`Thiếu ${signals.currentGap} người (${Math.round(gapRatio * 100)}% nhu cầu) — mức thiếu hụt cao.`);
    } else if (gapRatio >= GAP_RATIO_MEDIUM) {
      score += 1;
      factors.push(`Thiếu ${signals.currentGap} người (${Math.round(gapRatio * 100)}% nhu cầu).`);
    } else {
      factors.push(`Thiếu ${signals.currentGap} người (dưới ${Math.round(GAP_RATIO_MEDIUM * 100)}% nhu cầu) — mức nhẹ.`);
    }
  }

  if (signals.recentExits > 0) {
    score += 1;
    factors.push(`${signals.recentExits} lao động đã nghỉ việc gần đây.`);
  }

  if (signals.recentMovementOutflow > 0) {
    score += 1;
    factors.push(`${signals.recentMovementOutflow} lượt thuyên chuyển đi gần đây.`);
  }

  if (signals.openRecruitmentGapCount > 0) {
    score += 1;
    factors.push(`${signals.openRecruitmentGapCount} Yêu cầu tuyển dụng đang mở còn thiếu người.`);
  }

  if (signals.upcomingDemandCount > 0) {
    score += 1;
    factors.push(`${signals.upcomingDemandCount} Workforce Request sắp đến hạn cần nhân lực.`);
  }

  const level: RiskLevel = score >= 2 ? "HIGH" : score >= 1 ? "MEDIUM" : "LOW";
  if (factors.length === 0) factors.push("Không có dấu hiệu rủi ro thiếu người rõ rệt.");

  return { level, score, factors };
}
