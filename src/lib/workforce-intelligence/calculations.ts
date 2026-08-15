import type {
  ConversionMetrics,
  DemandComponent,
  ForecastConfidence,
  ForecastPoint,
  ForecastSummary,
  GapMetrics,
  RecruitmentVelocity,
  RequiredApplications,
  ScenarioOverrides,
  WorkforceDemand,
  WorkforceSupply,
} from "./types.ts";

export type DemandRecord = {
  id: string;
  departmentId: string;
  startDate: string;
  endDate: string;
  value: number;
  source: DemandComponent["source"];
  status: string;
  supersededBy: string | null;
  lastUpdatedAt: string | null;
};

export type SupplyEvent = {
  departmentId: string;
  effectiveDate: string;
  type: "CONFIRMED_INCOMING" | "EXPECTED_RETURNING" | "EXPECTED_EXIT" | "TRANSFER_IN" | "TRANSFER_OUT";
  quantity: number;
};

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function addDateDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function enumerateDates(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from, guard = 0; date <= to && guard < 367; date = addDateDays(date, 1), guard++) dates.push(date);
  return dates;
}

export function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

export function calculateDemand(components: DemandComponent[]): WorkforceDemand {
  return {
    total: components.filter((c) => c.available && c.value !== null).reduce((sum, c) => sum + finiteNonNegative(c.value ?? 0), 0),
    components: components.map((c) => ({ ...c, value: c.value === null ? null : finiteNonNegative(c.value) })),
  };
}

export function calculateSupply(input: {
  currentActive: number;
  confirmedIncoming: number;
  expectedReturning: number;
  transferIn: number;
  expectedExits: number;
  transferOut: number;
  provenance?: WorkforceSupply["provenance"];
}): WorkforceSupply {
  const currentActive = finiteNonNegative(input.currentActive);
  const confirmedIncoming = finiteNonNegative(input.confirmedIncoming);
  const expectedReturning = finiteNonNegative(input.expectedReturning);
  const transferIn = finiteNonNegative(input.transferIn);
  const expectedExits = finiteNonNegative(input.expectedExits);
  const transferOut = finiteNonNegative(input.transferOut);
  return {
    recordedCurrentWorkforce: currentActive,
    realTimePresentWorkforce: null,
    currentActive,
    confirmedIncoming,
    expectedReturning,
    transferIn,
    expectedExits,
    transferOut,
    expectedSupply: Math.max(0, currentActive + confirmedIncoming + expectedReturning + transferIn - expectedExits - transferOut),
    provenance: input.provenance ?? [],
  };
}

/** Canonical convention: gap = expectedSupply - demand. */
export function calculateGap(demand: number, expectedSupply: number): GapMetrics {
  const d = finiteNonNegative(demand);
  const s = finiteNonNegative(expectedSupply);
  const gap = s - d;
  return {
    demand: d,
    expectedSupply: s,
    gap,
    shortage: Math.max(0, -gap),
    surplus: Math.max(0, gap),
    coverageRate: d > 0 ? round((s / d) * 100) : null,
  };
}

/** Only current, non-superseded, positive authorized demand enters analytics. */
export function filterEffectiveDemandRecords(records: DemandRecord[]): DemandRecord[] {
  return records.filter((r) => r.status === "ACTIVE" && r.supersededBy === null && r.value > 0 && r.startDate <= r.endDate);
}

export function buildForecast(input: {
  from: string;
  to: string;
  currentActive: number;
  demandRecords: DemandRecord[];
  supplyEvents: SupplyEvent[];
  confidence: ForecastConfidence;
}): ForecastSummary {
  const records = filterEffectiveDemandRecords(input.demandRecords);
  const events = input.supplyEvents.map((e) => ({ ...e, quantity: finiteNonNegative(e.quantity) }));
  const points = enumerateDates(input.from, input.to).map((date): ForecastPoint => {
    const demand = records
      .filter((r) => r.startDate <= date && r.endDate >= date)
      .reduce((sum, r) => sum + r.value, 0);
    const cumulative = (type: SupplyEvent["type"]) => events
      .filter((e) => e.type === type && e.effectiveDate <= date)
      .reduce((sum, e) => sum + e.quantity, 0);
    const expectedIncoming = cumulative("CONFIRMED_INCOMING");
    const expectedReturning = cumulative("EXPECTED_RETURNING");
    const expectedExit = cumulative("EXPECTED_EXIT");
    const transferIn = cumulative("TRANSFER_IN");
    const transferOut = cumulative("TRANSFER_OUT");
    const expectedSupply = Math.max(
      0,
      finiteNonNegative(input.currentActive) + expectedIncoming + expectedReturning + transferIn - expectedExit - transferOut,
    );
    return {
      date,
      recordedCurrentWorkforce: finiteNonNegative(input.currentActive),
      currentSupply: finiteNonNegative(input.currentActive),
      expectedIncoming,
      expectedReturning,
      expectedExit,
      transferIn,
      transferOut,
      ...calculateGap(demand, expectedSupply),
    };
  });
  return summarizeForecast(points, input.confidence);
}

export function summarizeForecast(points: ForecastPoint[], confidence: ForecastConfidence): ForecastSummary {
  const firstRisk = points.find((p) => p.gap < 0) ?? null;
  let peak: ForecastPoint | null = null;
  for (const point of points) {
    if (point.shortage > (peak?.shortage ?? 0)) peak = point;
  }
  return {
    points,
    firstRiskDate: firstRisk?.date ?? null,
    peakShortageDate: peak && peak.shortage > 0 ? peak.date : null,
    peakShortage: peak?.shortage ?? 0,
    confidence,
  };
}

export function aggregateForecasts(forecasts: ForecastSummary[], confidence: ForecastConfidence): ForecastSummary {
  const dateMap = new Map<string, ForecastPoint>();
  for (const forecast of forecasts) {
    for (const point of forecast.points) {
      const row = dateMap.get(point.date) ?? {
        date: point.date,
        recordedCurrentWorkforce: 0,
        currentSupply: 0,
        expectedIncoming: 0,
        expectedReturning: 0,
        expectedExit: 0,
        transferIn: 0,
        transferOut: 0,
        demand: 0,
        expectedSupply: 0,
        gap: 0,
        shortage: 0,
        surplus: 0,
        coverageRate: null,
      };
      row.recordedCurrentWorkforce += point.recordedCurrentWorkforce;
      row.currentSupply += point.currentSupply;
      row.expectedIncoming += point.expectedIncoming;
      row.expectedReturning += point.expectedReturning;
      row.expectedExit += point.expectedExit;
      row.transferIn += point.transferIn;
      row.transferOut += point.transferOut;
      row.demand += point.demand;
      row.expectedSupply += point.expectedSupply;
      dateMap.set(point.date, row);
    }
  }
  const points = [...dateMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((point) => ({ ...point, ...calculateGap(point.demand, point.expectedSupply) }));
  return summarizeForecast(points, confidence);
}

export function applyScenarioToForecast(
  forecast: ForecastSummary,
  overrides: ScenarioOverrides,
  startedVelocityPerDay: number,
): ForecastSummary {
  const additionalIncoming = Math.floor(finiteNonNegative(overrides.additionalIncoming ?? 0));
  const returning = Math.floor(finiteNonNegative(overrides.returningWorkersActivated ?? 0));
  const retained = Math.floor(finiteNonNegative(overrides.retainedExpectedExits ?? 0));
  const multiplier = Math.max(0, overrides.recruitmentVelocityMultiplier ?? 1);
  const incrementalVelocity = Math.max(0, startedVelocityPerDay * (multiplier - 1));

  const points = forecast.points.map((original, index) => {
    const velocityIncoming = Math.floor(incrementalVelocity * (index + 1));
    const retainedAtDate = Math.min(retained, original.expectedExit);
    const expectedSupply = original.expectedSupply + additionalIncoming + returning + retainedAtDate + velocityIncoming;
    return {
      ...original,
      expectedIncoming: original.expectedIncoming + additionalIncoming + velocityIncoming,
      expectedReturning: original.expectedReturning + returning,
      expectedExit: Math.max(0, original.expectedExit - retainedAtDate),
      ...calculateGap(original.demand, expectedSupply),
    };
  });
  const confidence: ForecastConfidence = {
    score: Math.min(forecast.confidence.score, 49),
    level: "LOW",
    explanation: "Kịch bản what-if là ước tính in-memory, không phải cam kết nhân lực và không ghi dữ liệu production.",
    warnings: [...forecast.confidence.warnings, "Kết quả scenario được phân loại ESTIMATED."],
  };
  return summarizeForecast(points, confidence);
}

export function calculateConversion(
  applications: number,
  approved: number,
  started: number,
  cohort: { from: string; to: string } | null = null,
): ConversionMetrics {
  const app = Math.floor(finiteNonNegative(applications));
  const appr = Math.floor(finiteNonNegative(approved));
  const start = Math.floor(finiteNonNegative(started));
  const rate = (from: number, to: number) => from > 0 ? round(Math.min(1, to / from), 4) : null;
  return {
    applications: app,
    approved: appr,
    started: start,
    applicationToApproved: rate(app, appr),
    approvedToStarted: rate(appr, start),
    applicationToStarted: rate(app, start),
    sampleSize: app,
    semantics: "APPLICATION_REGISTRATION_COHORT",
    cohort,
  };
}

export function calculateRequiredApplications(
  shortage: number,
  conversionRate: number | null,
  safetyBufferPct = 10,
  quality: { sampleSize?: number; minimumSampleSize?: number; confidenceLevel?: "HIGH" | "MEDIUM" | "LOW" } = {},
): RequiredApplications {
  const short = Math.ceil(finiteNonNegative(shortage));
  const buffer = Math.max(0, Math.min(100, safetyBufferPct));
  if (short === 0) {
    return { shortage: 0, conversionRate, safetyBufferPct: buffer, requiredAdditionalApplications: 0, warning: null };
  }
  if (conversionRate === null || conversionRate <= 0 || conversionRate > 1) {
    return {
      shortage: short,
      conversionRate: conversionRate && conversionRate > 0 && conversionRate <= 1 ? conversionRate : null,
      safetyBufferPct: buffer,
      requiredAdditionalApplications: null,
      warning: "Chưa đủ dữ liệu conversion Application → Started để ước tính lượt đăng ký cần thêm.",
    };
  }
  const minimumSampleSize = quality.minimumSampleSize ?? 30;
  if (quality.sampleSize !== undefined && quality.sampleSize < minimumSampleSize) {
    return {
      shortage: short,
      conversionRate,
      safetyBufferPct: buffer,
      requiredAdditionalApplications: null,
      warning: `Mẫu conversion chỉ có ${quality.sampleSize} applications, thấp hơn ngưỡng ${minimumSampleSize}; không tạo ước tính chắc chắn.`,
    };
  }
  if (quality.confidenceLevel === "LOW") {
    return {
      shortage: short,
      conversionRate,
      safetyBufferPct: buffer,
      requiredAdditionalApplications: null,
      warning: "Forecast confidence LOW; không tạo số lượt đăng ký cần thêm như một kết luận chắc chắn.",
    };
  }
  return {
    shortage: short,
    conversionRate,
    safetyBufferPct: buffer,
    requiredAdditionalApplications: Math.ceil((short / conversionRate) * (1 + buffer / 100)),
    warning: "Ước tính có điều kiện: chỉ đúng nếu conversion của cohort hiện tại tiếp tục được duy trì.",
  };
}

export function calculateVelocity(input: {
  applications: number;
  approved: number;
  started: number;
  observationDays: number;
  shortage: number;
}): RecruitmentVelocity {
  const days = Math.max(1, Math.floor(input.observationDays));
  const applicationsPerDay = round(finiteNonNegative(input.applications) / days, 2);
  const approvedPerDay = round(finiteNonNegative(input.approved) / days, 2);
  const startedPerDay = round(finiteNonNegative(input.started) / days, 2);
  const shortage = finiteNonNegative(input.shortage);
  return {
    observationDays: days,
    dayBasis: "COMPLETED_CALENDAR_DAYS",
    includesIncompleteCurrentDay: false,
    applicationsPerDay,
    approvedPerDay,
    startedPerDay,
    expectedDaysToCloseGap: shortage === 0 ? 0 : startedPerDay > 0 ? round(shortage / startedPerDay, 1) : null,
    warning: days < 14
      ? "Khoảng quan sát dưới 14 ngày; velocity có thể chưa ổn định."
      : input.applications < 30
        ? "Mẫu lịch sử dưới 30 applications; cần thận trọng khi dùng velocity."
        : null,
  };
}

export function isSourceStale(lastSuccessfulSyncAt: string | null, nowIso: string, staleAfterHours: number): boolean {
  if (!lastSuccessfulSyncAt) return true;
  const ageMs = Date.parse(nowIso) - Date.parse(lastSuccessfulSyncAt);
  return !Number.isFinite(ageMs) || ageMs > staleAfterHours * 3_600_000;
}

export function calculateForecastConfidence(input: {
  demandAvailable: boolean;
  currentSupplyAvailable: boolean;
  confirmedDataRatio: number;
  historicalSampleSize: number;
  volatility: number | null;
  horizonDays: number;
  missingCriticalSources: string[];
  staleSources: string[];
}): ForecastConfidence {
  let score = 100;
  const warnings: string[] = [];
  if (!input.demandAvailable) {
    score -= 35;
    warnings.push("Không có demand đã được phê duyệt trong kỳ.");
  }
  if (!input.currentSupplyAvailable) {
    score -= 40;
    warnings.push("Không có snapshot current active workforce.");
  }
  const confirmedRatio = Math.max(0, Math.min(1, input.confirmedDataRatio));
  score -= Math.round((1 - confirmedRatio) * 20);
  if (confirmedRatio < 0.5) {
    score -= 20;
    warnings.push("Data completeness dưới 50%; forecast chỉ nên dùng để rà soát dữ liệu.");
  }
  if (input.historicalSampleSize < 30) {
    score -= 12;
    warnings.push("Mẫu lịch sử tuyển dụng nhỏ hơn 30 applications.");
  }
  if (input.volatility !== null && input.volatility > 0.35) {
    score -= 10;
    warnings.push("Recruitment velocity có biến động cao.");
  }
  if (input.horizonDays > 60) score -= 15;
  else if (input.horizonDays > 30) score -= 8;
  if (input.missingCriticalSources.length > 0) {
    score -= Math.min(24, input.missingCriticalSources.length * 8);
    // A forecast cannot be HIGH confidence while a declared critical source is unavailable.
    score = Math.min(score, 74);
    warnings.push(`Nguồn chưa tích hợp: ${input.missingCriticalSources.join(", ")}.`);
  }
  if (input.staleSources.length > 0) {
    score -= Math.min(30, input.staleSources.length * 15);
    warnings.push(`Nguồn dữ liệu cũ: ${input.staleSources.join(", ")}.`);
  }
  score = Math.max(0, Math.min(100, score));
  const level = score >= 75 ? "HIGH" : score >= 50 ? "MEDIUM" : "LOW";
  const explanation = level === "HIGH"
    ? "Phần lớn demand/supply có nguồn xác nhận và mẫu lịch sử đủ dùng."
    : level === "MEDIUM"
      ? "Forecast dùng dữ liệu Seasonal Worker có xác nhận nhưng còn thiếu một số nguồn workforce bên ngoài."
      : "Forecast có dữ liệu thiếu, cũ hoặc mẫu lịch sử nhỏ; không nên xem là cam kết nhân lực.";
  return { score, level, explanation, warnings };
}
