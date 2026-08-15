import type { ConfidenceLevel, RiskAssessment, RiskFactor, RiskLevel } from "./types.ts";

/** Central deterministic risk policy. No AI/model code may alter these thresholds. */
export const RISK_THRESHOLDS: Readonly<Record<RiskLevel, { min: number; max: number }>> = {
  LOW: { min: 0, max: 24 },
  MEDIUM: { min: 25, max: 49 },
  HIGH: { min: 50, max: 74 },
  CRITICAL: { min: 75, max: 100 },
};

export type RiskInput = {
  demand: number;
  expectedSupply: number;
  shortage: number;
  coverageRate: number | null;
  daysToRequired: number | null;
  startedVelocityPerDay: number;
  expectedDaysToCloseGap: number | null;
  expectedExits: number;
  returningPool: number;
  pipelineAvailable: boolean;
  pipelineExpectedStart: number;
  conversionRate: number | null;
  confidenceLevel: ConfidenceLevel;
};

export function riskLevelForScore(score: number): RiskLevel {
  if (score >= RISK_THRESHOLDS.CRITICAL.min) return "CRITICAL";
  if (score >= RISK_THRESHOLDS.HIGH.min) return "HIGH";
  if (score >= RISK_THRESHOLDS.MEDIUM.min) return "MEDIUM";
  return "LOW";
}

function factor(key: string, contribution: number, explanation: string, evidence: RiskFactor["evidence"]): RiskFactor {
  return { key, contribution, explanation, evidence };
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const factors: RiskFactor[] = [];
  const shortage = Math.max(0, input.shortage);

  if (shortage > 0 && input.coverageRate !== null) {
    const coverage = input.coverageRate;
    const rawContribution = coverage < 70 ? 35 : coverage < 80 ? 30 : coverage < 90 ? 20 : coverage < 100 ? 10 : 0;
    // Avoid turning a 1–4 person shortage into CRITICAL solely because percentage coverage is low.
    const contribution = shortage < 5 ? Math.min(10, rawContribution) : shortage < 10 ? Math.min(15, rawContribution) : rawContribution;
    if (contribution > 0) {
      factors.push(factor(
        "LOW_COVERAGE",
        contribution,
        `Coverage chỉ đạt ${coverage.toLocaleString("vi-VN")}% trong kỳ đánh giá.`,
        { coverageRate: coverage, shortage },
      ));
    }
  }

  if (shortage > 0) {
    const shortageRate = input.demand > 0 ? shortage / input.demand : 0;
    const contribution = shortageRate >= 0.3 || shortage >= 100 ? 25 : shortageRate >= 0.15 || shortage >= 50 ? 18 : shortage >= 10 ? 10 : 5;
    factors.push(factor(
      "SHORTAGE_SIZE",
      contribution,
      `Projected shortage là ${shortage.toLocaleString("vi-VN")} người.`,
      { shortage, demand: input.demand, shortageRate: Math.round(shortageRate * 1000) / 10 },
    ));
  }

  if (shortage > 0 && input.daysToRequired !== null) {
    const days = Math.max(0, input.daysToRequired);
    const contribution = days <= 3 ? 20 : days <= 7 ? 16 : days <= 14 ? 11 : days <= 30 ? 5 : 0;
    if (contribution > 0) {
      factors.push(factor(
        "SHORT_LEAD_TIME",
        contribution,
        days === 0 ? "Thiếu hụt đã bắt đầu trong snapshot hiện tại." : `Còn ${days} ngày trước thời điểm bắt đầu thiếu người.`,
        { daysToRequired: days },
      ));
    }
  }

  if (shortage > 0 && input.startedVelocityPerDay <= 0) {
    factors.push(factor(
      "NO_STARTED_VELOCITY",
      10,
      "Không ghi nhận started velocity trong kỳ lịch sử; chưa có bằng chứng gap sẽ được đóng bằng tuyển dụng hiện tại.",
      { startedVelocityPerDay: input.startedVelocityPerDay },
    ));
  } else if (
    shortage > 0 &&
    input.daysToRequired !== null &&
    input.expectedDaysToCloseGap !== null &&
    input.expectedDaysToCloseGap > input.daysToRequired
  ) {
    factors.push(factor(
      "VELOCITY_BEHIND_REQUIRED_DATE",
      10,
      "Tốc độ started hiện tại dự kiến đóng gap sau thời điểm cần đủ người.",
      { expectedDaysToCloseGap: input.expectedDaysToCloseGap, daysToRequired: input.daysToRequired },
    ));
  }

  if (shortage > 0 && input.expectedExits > 0) {
    const contribution = Math.min(8, Math.max(3, Math.ceil((input.expectedExits / Math.max(1, input.expectedSupply)) * 40)));
    factors.push(factor(
      "EXPECTED_EXITS",
      contribution,
      `${input.expectedExits} expected exits đã xác nhận làm giảm supply trong kỳ.`,
      { expectedExits: input.expectedExits },
    ));
  }

  if (shortage > 0 && input.pipelineAvailable && input.pipelineExpectedStart < shortage) {
    factors.push(factor(
      "WEAK_PIPELINE",
      8,
      "ATS expected-start pipeline hiện thấp hơn projected shortage.",
      { pipelineExpectedStart: input.pipelineExpectedStart, shortage },
    ));
  }

  if (shortage > 0 && input.conversionRate !== null && input.conversionRate < 0.25) {
    factors.push(factor(
      "LOW_CONVERSION",
      7,
      "Conversion Application → Started dưới 25%.",
      { conversionRate: Math.round(input.conversionRate * 1000) / 10 },
    ));
  }

  if (shortage > 0 && input.confidenceLevel === "LOW") {
    factors.push(factor(
      "LOW_DATA_CONFIDENCE",
      5,
      "Độ tin cậy dữ liệu thấp; mức thiếu hụt thực tế có thể khác forecast.",
      { confidence: "LOW" },
    ));
  }

  // Returning pool is an opportunity, not confirmed supply, so it never subtracts risk.
  void input.returningPool;
  const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.contribution, 0)));
  return { score, level: riskLevelForScore(score), factors };
}
