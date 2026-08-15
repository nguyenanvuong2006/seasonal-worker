import type { IntegrationSourceStatus, SourceSystem } from "../integrations/types.ts";
import type { AnalyticsCompleteness } from "./diagnostics.ts";

export type DataCertainty = "ACTUAL" | "RECORDED" | "CONFIRMED" | "EXPECTED" | "ESTIMATED" | "UNAVAILABLE";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";
export type DemandSource = "PLANNING" | "RECRUITMENT_REQUEST" | "MANUAL_ADJUSTMENT";

export type MetricProvenance = {
  system: SourceSystem;
  recordCount: number | null;
  lastUpdatedAt: string | null;
  certainty: DataCertainty;
};

export type DemandComponent = {
  source: DemandSource;
  /** null means unavailable; it must not be interpreted as numeric zero. */
  value: number | null;
  available: boolean;
  provenance: MetricProvenance;
};

export type WorkforceDemand = {
  total: number;
  components: DemandComponent[];
};

export type WorkforceSupply = {
  /** Session-derived recorded workforce; not real-time attendance/presence. */
  recordedCurrentWorkforce: number;
  /** Always null until an Attendance/HRIS presence source is integrated. */
  realTimePresentWorkforce: number | null;
  /** @deprecated compatibility alias; use recordedCurrentWorkforce in UI/AI. */
  currentActive: number;
  confirmedIncoming: number;
  expectedReturning: number;
  transferIn: number;
  expectedExits: number;
  transferOut: number;
  expectedSupply: number;
  provenance: MetricProvenance[];
};

export type GapMetrics = {
  demand: number;
  expectedSupply: number;
  /** Canonical convention: gap = expectedSupply - demand; negative means shortage. */
  gap: number;
  shortage: number;
  surplus: number;
  coverageRate: number | null;
};

export type ForecastPoint = GapMetrics & {
  date: string;
  /** Session-derived baseline, not real-time attendance. */
  recordedCurrentWorkforce: number;
  /** @deprecated compatibility alias. */
  currentSupply: number;
  expectedIncoming: number;
  expectedReturning: number;
  expectedExit: number;
  transferIn: number;
  transferOut: number;
};

export type ForecastConfidence = {
  score: number;
  level: ConfidenceLevel;
  explanation: string;
  warnings: string[];
};

export type ForecastSummary = {
  points: ForecastPoint[];
  firstRiskDate: string | null;
  peakShortageDate: string | null;
  peakShortage: number;
  confidence: ForecastConfidence;
};

export type ConversionMetrics = {
  applications: number;
  approved: number;
  started: number;
  applicationToApproved: number | null;
  approvedToStarted: number | null;
  applicationToStarted: number | null;
  sampleSize: number;
  semantics: "APPLICATION_REGISTRATION_COHORT";
  cohort: { from: string; to: string } | null;
};

export type RequiredApplications = {
  shortage: number;
  conversionRate: number | null;
  safetyBufferPct: number;
  requiredAdditionalApplications: number | null;
  warning: string | null;
};

export type RecruitmentVelocity = {
  observationDays: number;
  dayBasis: "COMPLETED_CALENDAR_DAYS";
  includesIncompleteCurrentDay: false;
  applicationsPerDay: number;
  approvedPerDay: number;
  startedPerDay: number;
  expectedDaysToCloseGap: number | null;
  warning: string | null;
};

export type ReferralPerformance = {
  source: string;
  applications: number;
  started: number;
  applicationToStarted: number | null;
};

export type PipelineSupply = {
  available: boolean;
  /** All stage values are null when ATS is unavailable; unavailable is not numeric zero. */
  applied: number | null;
  screened: number | null;
  shortlisted: number | null;
  interview: number | null;
  offered: number | null;
  accepted: number | null;
  onboarding: number | null;
  expectedStart: number | null;
  probabilityWeightedSupply: number | null;
  message: string;
};

export type RiskFactor = {
  key: string;
  contribution: number;
  explanation: string;
  evidence: Record<string, number | string | null>;
};

export type RiskAssessment = {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
};

export type ActionKey =
  | "ACCELERATE_RECRUITMENT"
  | "REACTIVATE_RETURNING_WORKERS"
  | "INCREASE_REFERRAL_CAMPAIGN"
  | "REVIEW_EXPECTED_EXITS"
  | "TRANSFER_INTERNAL_WORKFORCE"
  | "OPEN_SUPPLEMENT_REQUEST"
  | "REVIEW_CONVERSION_DROP"
  | "ESCALATE_TO_HR_MANAGEMENT"
  | "MONITOR";

export type ActionPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export type RecommendedAction = {
  actionKey: ActionKey;
  priority: ActionPriority;
  reason: string;
  affectedDepartment: { id: string; name: string } | null;
  target: number | null;
  deadline: string | null;
  evidence: string[];
};

export type DepartmentIntelligence = {
  departmentId: string;
  departmentName: string;
  groupName: string;
  location: string;
  division: string;
  asOfDate: string;
  demand: WorkforceDemand;
  supply: WorkforceSupply;
  gap: GapMetrics;
  forecast: ForecastSummary;
  risk: RiskAssessment;
  conversion: ConversionMetrics;
  requiredApplications: RequiredApplications;
  velocity: RecruitmentVelocity;
  referralPerformance: ReferralPerformance[];
  returningWorkerOpportunity: number;
  diagnostics: AnalyticsCompleteness;
  pipeline: PipelineSupply;
  recommendedActions: RecommendedAction[];
};

export type WorkforceIntelligenceOverview = {
  generatedAt: string;
  period: { from: string; to: string; label: string };
  scope: { restricted: boolean; departmentCount: number; note: string };
  outOfScope: boolean;
  asOfDate: string;
  demand: WorkforceDemand;
  supply: WorkforceSupply;
  gap: GapMetrics;
  forecast: ForecastSummary;
  risk: RiskAssessment;
  conversion: ConversionMetrics;
  requiredApplications: RequiredApplications;
  velocity: RecruitmentVelocity;
  referralPerformance: ReferralPerformance[];
  returningWorkerOpportunity: number;
  expectedExits: number;
  diagnostics: AnalyticsCompleteness;
  pipeline: PipelineSupply;
  departments: DepartmentIntelligence[];
  recommendedActions: RecommendedAction[];
  sources: IntegrationSourceStatus[];
  dataFreshnessWarnings: string[];
  scenario: { applied: boolean; mode: "SIMULATION" | null; overrides: ScenarioOverrides | null; classification: "ESTIMATED" | null };
};

export type ScenarioOverrides = {
  targetDepartmentId: string;
  additionalIncoming?: number;
  retainedExpectedExits?: number;
  returningWorkersActivated?: number;
  recruitmentVelocityMultiplier?: number;
};

export type OutlookFilters = {
  from: string;
  to: string;
  departmentId: string | null;
};

export type WorkforceAIAnalysis = {
  executiveSummary: string;
  riskLevel: RiskLevel;
  keyFindings: { title: string; explanation: string; metric?: string }[];
  risks: { title: string; severity: RiskLevel; explanation: string; evidence: string[] }[];
  opportunities: { title: string; explanation: string }[];
  recommendedActions: {
    priority: ActionPriority;
    action: string;
    reason: string;
    deadline?: string;
  }[];
  confidence: { level: ConfidenceLevel; explanation: string };
};

export type WorkforceAIChatResponse = {
  answer: string;
  riskLevel: RiskLevel | null;
  evidence: string[];
  recommendedActionKeys: ActionKey[];
  confidence: { level: ConfidenceLevel; explanation: string };
  scopeNote: string;
};
