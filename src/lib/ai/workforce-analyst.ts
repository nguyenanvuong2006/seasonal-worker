import type { AIProvider, AIProviderResult } from "./types.ts";
import { WORKFORCE_ANALYSIS_PROMPT, WORKFORCE_CHAT_PROMPT } from "./prompts.ts";
import type {
  ActionKey,
  ActionPriority,
  ConfidenceLevel,
  DepartmentIntelligence,
  RiskLevel,
  WorkforceAIAnalysis,
  WorkforceAIChatResponse,
  WorkforceIntelligenceOverview,
} from "../workforce-intelligence/types.ts";

const RISK_LEVELS = new Set<RiskLevel>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const CONFIDENCE_LEVELS = new Set<ConfidenceLevel>(["LOW", "MEDIUM", "HIGH"]);
const PRIORITIES = new Set<ActionPriority>(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const ACTION_KEYS = new Set<ActionKey>([
  "ACCELERATE_RECRUITMENT",
  "REACTIVATE_RETURNING_WORKERS",
  "INCREASE_REFERRAL_CAMPAIGN",
  "REVIEW_EXPECTED_EXITS",
  "TRANSFER_INTERNAL_WORKFORCE",
  "OPEN_SUPPLEMENT_REQUEST",
  "REVIEW_CONVERSION_DROP",
  "ESCALATE_TO_HR_MANAGEMENT",
  "MONITOR",
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI response must be a JSON object.");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`AI response field ${field} is invalid.`);
  return value.trim().slice(0, max);
}

function array(value: unknown, field: string, max = 12): unknown[] {
  if (!Array.isArray(value)) throw new Error(`AI response field ${field} must be an array.`);
  return value.slice(0, max);
}

function riskLevel(value: unknown): RiskLevel {
  if (!RISK_LEVELS.has(value as RiskLevel)) throw new Error("AI riskLevel is invalid.");
  return value as RiskLevel;
}

function confidenceLevel(value: unknown): ConfidenceLevel {
  if (!CONFIDENCE_LEVELS.has(value as ConfidenceLevel)) throw new Error("AI confidence level is invalid.");
  return value as ConfidenceLevel;
}

export function validateAnalysis(value: unknown): WorkforceAIAnalysis {
  const root = record(value);
  const confidence = record(root.confidence);
  return {
    executiveSummary: text(root.executiveSummary, "executiveSummary"),
    riskLevel: riskLevel(root.riskLevel),
    keyFindings: array(root.keyFindings, "keyFindings").map((item) => {
      const r = record(item);
      return { title: text(r.title, "keyFindings.title", 200), explanation: text(r.explanation, "keyFindings.explanation", 1000), ...(typeof r.metric === "string" ? { metric: r.metric.slice(0, 120) } : {}) };
    }),
    risks: array(root.risks, "risks").map((item) => {
      const r = record(item);
      return {
        title: text(r.title, "risks.title", 200),
        severity: riskLevel(r.severity),
        explanation: text(r.explanation, "risks.explanation", 1000),
        evidence: array(r.evidence, "risks.evidence", 8).map((e) => text(e, "risks.evidence[]", 300)),
      };
    }),
    opportunities: array(root.opportunities, "opportunities").map((item) => {
      const r = record(item);
      return { title: text(r.title, "opportunities.title", 200), explanation: text(r.explanation, "opportunities.explanation", 1000) };
    }),
    recommendedActions: array(root.recommendedActions, "recommendedActions").map((item) => {
      const r = record(item);
      if (!PRIORITIES.has(r.priority as ActionPriority)) throw new Error("AI action priority is invalid.");
      return {
        priority: r.priority as ActionPriority,
        action: text(r.action, "recommendedActions.action", 300),
        reason: text(r.reason, "recommendedActions.reason", 800),
        ...(typeof r.deadline === "string" && r.deadline ? { deadline: r.deadline.slice(0, 40) } : {}),
      };
    }),
    confidence: { level: confidenceLevel(confidence.level), explanation: text(confidence.explanation, "confidence.explanation", 800) },
  };
}

export function validateChat(value: unknown): WorkforceAIChatResponse {
  const root = record(value);
  const confidence = record(root.confidence);
  return {
    answer: text(root.answer, "answer", 5000),
    riskLevel: root.riskLevel === null || root.riskLevel === undefined ? null : riskLevel(root.riskLevel),
    evidence: array(root.evidence, "evidence", 10).map((e) => text(e, "evidence[]", 400)),
    recommendedActionKeys: array(root.recommendedActionKeys, "recommendedActionKeys", 10)
      .filter((key): key is ActionKey => ACTION_KEYS.has(key as ActionKey)),
    confidence: { level: confidenceLevel(confidence.level), explanation: text(confidence.explanation, "confidence.explanation", 800) },
    scopeNote: text(root.scopeNote, "scopeNote", 500),
  };
}

function samplePoints<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const result: T[] = [];
  for (let i = 0; i < max; i++) result.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  return result;
}

function departmentGrounding(d: DepartmentIntelligence) {
  return {
    departmentId: d.departmentId,
    departmentName: d.departmentName,
    groupName: d.groupName,
    asOfDate: d.asOfDate,
    demand: d.gap.demand,
    recordedCurrentWorkforce: d.supply.recordedCurrentWorkforce,
    realTimePresentWorkforce: d.supply.realTimePresentWorkforce,
    expectedSupply: d.gap.expectedSupply,
    gap: d.gap.gap,
    shortage: d.gap.shortage,
    coverageRate: d.gap.coverageRate,
    firstRiskDate: d.forecast.firstRiskDate,
    peakShortageDate: d.forecast.peakShortageDate,
    risk: d.risk,
    velocity: d.velocity,
    conversion: d.conversion,
    referralPerformance: d.referralPerformance.slice(0, 5),
    requiredApplications: d.requiredApplications,
    returningWorkerOpportunity: d.returningWorkerOpportunity,
    expectedExits: d.supply.expectedExits,
    diagnostics: d.diagnostics,
    pipeline: d.pipeline,
    confidence: d.forecast.confidence,
    deterministicActionCandidates: d.recommendedActions,
  };
}

function normalizeForMatch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLowerCase();
}

export function selectQuestionDepartments(question: string, outlook: WorkforceIntelligenceOverview): DepartmentIntelligence[] {
  const normalized = normalizeForMatch(question);
  const matched = outlook.departments.filter((d) => {
    const names = [d.departmentName, d.groupName, `${d.departmentName} ${d.groupName}`].filter(Boolean);
    return names.some((name) => {
      const needle = normalizeForMatch(name);
      return needle.length >= 3 && normalized.includes(needle);
    });
  });
  return (matched.length ? matched : outlook.departments).slice(0, 10);
}

const SENSITIVE_AI_KEYS = [
  "cccd", "cmnd", "phone", "email", "dob", "dateofbirth", "address", "password", "passwordhash",
  "session", "authsecret", "databaseurl", "connectionstring", "rawworkers", "workerlist",
];

/** Defense-in-depth guard: grounding must stay aggregate and credential/PII-free. */
export function assertNoSensitiveFields(payload: unknown, path = "payload"): void {
  if (Array.isArray(payload)) {
    payload.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`));
    return;
  }
  if (!payload || typeof payload !== "object") return;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (SENSITIVE_AI_KEYS.includes(normalizedKey)) {
      throw new Error(`Sensitive field is not allowed in AI grounding: ${path}.${key}`);
    }
    assertNoSensitiveFields(value, `${path}.${key}`);
  }
}

export function buildWorkforceGrounding(outlook: WorkforceIntelligenceOverview, departments = outlook.departments.slice(0, 10)) {
  const payload = {
    generatedAt: outlook.generatedAt,
    period: outlook.period,
    scopeNote: outlook.scope.note,
    scopeRestricted: outlook.scope.restricted,
    sourceStatuses: outlook.sources,
    dataFreshnessWarnings: outlook.dataFreshnessWarnings,
    asOfDate: outlook.asOfDate,
    kpis: {
      demand: outlook.gap.demand,
      recordedCurrentWorkforce: outlook.supply.recordedCurrentWorkforce,
      realTimePresentWorkforce: outlook.supply.realTimePresentWorkforce,
      expectedSupply: outlook.gap.expectedSupply,
      gap: outlook.gap.gap,
      shortage: outlook.gap.shortage,
      surplus: outlook.gap.surplus,
      coverageRate: outlook.gap.coverageRate,
      expectedExits: outlook.expectedExits,
      returningWorkerOpportunity: outlook.returningWorkerOpportunity,
    },
    risk: outlook.risk,
    confidence: outlook.forecast.confidence,
    forecast: samplePoints(outlook.forecast.points, 30).map((p) => ({ date: p.date, demand: p.demand, expectedSupply: p.expectedSupply, gap: p.gap })),
    conversion: outlook.conversion,
    velocity: outlook.velocity,
    referralPerformance: outlook.referralPerformance,
    requiredApplications: outlook.requiredApplications,
    diagnostics: outlook.diagnostics,
    workforceMetricSemantics: {
      recordedCurrentWorkforce: "Latest valid APPROVED Employment Session; not real-time attendance/presence.",
      realTimePresentWorkforce: "UNAVAILABLE because Attendance is not integrated.",
      conversion: "Application registration cohort over completed calendar days.",
    },
    pipeline: outlook.pipeline,
    departments: departments.map(departmentGrounding),
    deterministicActionCandidates: outlook.recommendedActions,
  };
  assertNoSensitiveFields(payload);
  return payload;
}

export async function analyzeWorkforceOutlook(
  provider: AIProvider,
  outlook: WorkforceIntelligenceOverview,
): Promise<AIProviderResult<WorkforceAIAnalysis>> {
  const result = await provider.generateStructured<unknown>({
    operation: "WORKFORCE_ANALYZE",
    systemPrompt: WORKFORCE_ANALYSIS_PROMPT,
    userPayload: buildWorkforceGrounding(outlook),
    maxOutputTokens: 1800,
    timeoutMs: 20_000,
  });
  const validated = validateAnalysis(result.data);
  if (!validateAIQuestion(JSON.stringify(validated), false).ok) throw new Error("AI response contained disallowed sensitive content.");
  // Deterministic backend remains the authority for risk, confidence and actions.
  validated.riskLevel = outlook.risk.level;
  validated.confidence = { level: outlook.forecast.confidence.level, explanation: outlook.forecast.confidence.explanation };
  validated.recommendedActions = outlook.recommendedActions.slice(0, 8).map((item) => ({
    priority: item.priority,
    action: item.actionKey,
    reason: item.reason,
    ...(item.deadline ? { deadline: item.deadline } : {}),
  }));
  return { ...result, data: validated };
}

export async function chatWithWorkforceOutlook(
  provider: AIProvider,
  question: string,
  outlook: WorkforceIntelligenceOverview,
): Promise<AIProviderResult<WorkforceAIChatResponse>> {
  const departments = selectQuestionDepartments(question, outlook);
  const result = await provider.generateStructured<unknown>({
    operation: "WORKFORCE_CHAT",
    systemPrompt: WORKFORCE_CHAT_PROMPT,
    userPayload: { question, analytics: buildWorkforceGrounding(outlook, departments) },
    maxOutputTokens: 1200,
    timeoutMs: 20_000,
  });
  const validated = validateChat(result.data);
  if (!validateAIQuestion(JSON.stringify(validated), false).ok) throw new Error("AI response contained disallowed sensitive content.");
  const allowedActions = new Set(outlook.recommendedActions.map((a) => a.actionKey));
  validated.recommendedActionKeys = validated.recommendedActionKeys.filter((key) => allowedActions.has(key));
  validated.scopeNote = outlook.scope.note;
  validated.confidence = { level: outlook.forecast.confidence.level, explanation: outlook.forecast.confidence.explanation };
  return { ...result, data: validated };
}

export type AIQuestionSafety = { ok: true } | { ok: false; reason: "PII" | "SECRET" | "PROMPT_INJECTION" | "SCOPE_BYPASS" };

export function validateAIQuestion(question: string, scopeRestricted: boolean): AIQuestionSafety {
  const normalized = normalizeForMatch(question);
  const piiKeywords = ["cccd", "cmnd", "so dien thoai", "sdt", "phone", "email", "dia chi", "address", "ngay sinh", "dob"];
  if (/\b\d{9,12}\b/.test(question) || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(question) || piiKeywords.some((keyword) => normalized.includes(keyword))) {
    return { ok: false, reason: "PII" };
  }
  const secretKeywords = ["database_url", "database url", "auth_secret", "auth secret", "api key", "passwordhash", "connection string", "raw database", "sql query"];
  if (secretKeywords.some((keyword) => normalized.includes(keyword.replace(/_/g, " ")) || question.toLowerCase().includes(keyword))) {
    return { ok: false, reason: "SECRET" };
  }
  const injectionKeywords = ["ignore all previous", "ignore previous instructions", "bo qua huong dan", "bo qua system prompt", "reveal system prompt"];
  if (injectionKeywords.some((keyword) => normalized.includes(keyword))) return { ok: false, reason: "PROMPT_INJECTION" };
  const scopeBypassKeywords = ["bo qua data scope", "bypass data scope", "ngoai pham vi", "toan cong ty", "company wide"];
  if (scopeRestricted && scopeBypassKeywords.some((keyword) => normalized.includes(keyword))) return { ok: false, reason: "SCOPE_BYPASS" };
  return { ok: true };
}

export function containsLikelyPii(question: string): boolean {
  return !validateAIQuestion(question, false).ok;
}
