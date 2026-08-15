import type { RecommendedAction, RiskAssessment } from "./types.ts";

export type ActionInput = {
  department: { id: string; name: string };
  shortage: number;
  coverageRate: number | null;
  firstRiskDate: string | null;
  daysToRequired: number | null;
  returningPool: number;
  expectedExits: number;
  availableInternalSurplus: number;
  requiredAdditionalApplications: number | null;
  topReferralSource: string | null;
  conversionRate: number | null;
  risk: RiskAssessment;
};

function action(
  input: ActionInput,
  values: Omit<RecommendedAction, "affectedDepartment">,
): RecommendedAction {
  return { ...values, affectedDepartment: input.department };
}

/** Deterministic recommendation policy. AI may explain but may not add actions. */
export function recommendActions(input: ActionInput): RecommendedAction[] {
  const actions: RecommendedAction[] = [];
  const shortage = Math.max(0, input.shortage);
  const urgent = input.risk.level === "CRITICAL";

  if (shortage > 0 && (input.coverageRate ?? 100) < 80 && (input.daysToRequired ?? 999) <= 14) {
    actions.push(action(input, {
      actionKey: "ACCELERATE_RECRUITMENT",
      priority: urgent ? "URGENT" : "HIGH",
      reason: "Coverage dưới 80% và lead time không quá 14 ngày.",
      target: input.requiredAdditionalApplications,
      deadline: input.firstRiskDate,
      evidence: [
        `Projected shortage: ${shortage}`,
        `Coverage: ${input.coverageRate ?? "N/A"}%`,
        `Required applications (có buffer): ${input.requiredAdditionalApplications ?? "chưa đủ conversion data"}`,
      ],
    }));
  }

  if (shortage > 0 && input.returningPool > 0) {
    actions.push(action(input, {
      actionKey: "REACTIVATE_RETURNING_WORKERS",
      priority: urgent ? "HIGH" : "MEDIUM",
      reason: "Có lao động từng làm tại bộ phận và hiện không active; đây là opportunity, chưa phải confirmed supply.",
      target: Math.min(shortage, input.returningPool),
      deadline: input.firstRiskDate,
      evidence: [`Returning pool: ${input.returningPool}`, `Projected shortage: ${shortage}`],
    }));
  }

  if (shortage > 0 && input.expectedExits > 0) {
    actions.push(action(input, {
      actionKey: "REVIEW_EXPECTED_EXITS",
      priority: urgent ? "HIGH" : "MEDIUM",
      reason: "Expected exits đã được phê duyệt đang làm giảm supply trong kỳ.",
      target: input.expectedExits,
      deadline: input.firstRiskDate,
      evidence: [`Expected exits: ${input.expectedExits}`],
    }));
  }

  if (shortage > 0 && input.availableInternalSurplus > 0) {
    actions.push(action(input, {
      actionKey: "TRANSFER_INTERNAL_WORKFORCE",
      priority: "MEDIUM",
      reason: "Có projected surplus trong các bộ phận khác thuộc đúng Data Scope; cần HR xác minh kỹ năng/lịch trước khi thực hiện.",
      target: Math.min(shortage, input.availableInternalSurplus),
      deadline: input.firstRiskDate,
      evidence: [`In-scope projected surplus: ${input.availableInternalSurplus}`, `Projected shortage: ${shortage}`],
    }));
  }

  if (shortage > 0 && input.topReferralSource && input.requiredAdditionalApplications !== null) {
    actions.push(action(input, {
      actionKey: "INCREASE_REFERRAL_CAMPAIGN",
      priority: urgent ? "HIGH" : "MEDIUM",
      reason: `Ưu tiên nguồn có started performance tốt nhất trong dữ liệu hiện có: ${input.topReferralSource}.`,
      target: input.requiredAdditionalApplications,
      deadline: input.firstRiskDate,
      evidence: [`Top source: ${input.topReferralSource}`, `Application → Started: ${input.conversionRate === null ? "N/A" : `${Math.round(input.conversionRate * 1000) / 10}%`}`],
    }));
  }

  // OPEN_SUPPLEMENT_REQUEST is deliberately not inferred from a supply shortage. A supplement
  // increases authorized demand; it does not close a supply gap. Emit it only when a future
  // demand-authorization diagnostic exists (not available in the current data model).

  if (input.risk.level === "CRITICAL") {
    actions.push(action(input, {
      actionKey: "ESCALATE_TO_HR_MANAGEMENT",
      priority: "URGENT",
      reason: "Deterministic risk score đạt ngưỡng CRITICAL.",
      target: shortage,
      deadline: input.firstRiskDate,
      evidence: input.risk.factors.slice(0, 3).map((f) => `${f.key}: +${f.contribution}`),
    }));
  }

  if (actions.length === 0) {
    actions.push(action(input, {
      actionKey: "MONITOR",
      priority: "LOW",
      reason: "Chưa ghi nhận projected shortage từ nguồn demand/supply hiện có.",
      target: null,
      deadline: null,
      evidence: [`Risk: ${input.risk.level} (${input.risk.score})`],
    }));
  }

  return actions;
}
