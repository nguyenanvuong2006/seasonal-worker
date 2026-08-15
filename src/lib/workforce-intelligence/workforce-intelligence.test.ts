import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateForecasts,
  applyScenarioToForecast,
  buildForecast,
  calculateConversion,
  calculateDemand,
  calculateForecastConfidence,
  calculateGap,
  calculateRequiredApplications,
  calculateSupply,
  calculateVelocity,
  filterEffectiveDemandRecords,
  isSourceStale,
  type DemandRecord,
} from "./calculations.ts";
import { assessRisk } from "./risk.ts";
import { recommendActions } from "./actions.ts";
import { buildAnalyticsCompleteness, completenessConfirmedRatio } from "./diagnostics.ts";
import { isConfirmedIncoming, isConfirmedResignationStatus, isRecordedCurrentWorkforce } from "./semantics.ts";
import { parseScenarioOverrides } from "./filters.ts";
import { canAccessDepartment, resolveAuthorizedToolDepartment, restrictDepartmentIds } from "./scope.ts";
import { validateRecruitmentDemand } from "../integrations/validators.ts";
import type { ForecastConfidence } from "./types.ts";
import type { RecruitmentDemand } from "../integrations/types.ts";

const CONFIDENCE: ForecastConfidence = { score: 70, level: "MEDIUM", explanation: "test", warnings: [] };
const DEMAND: DemandRecord = {
  id: "p1", departmentId: "d1", startDate: "2026-09-01", endDate: "2026-09-30",
  value: 100, source: "PLANNING", status: "ACTIVE", supersededBy: null, lastUpdatedAt: null,
};

function riskInput(over: Partial<Parameters<typeof assessRisk>[0]> = {}): Parameters<typeof assessRisk>[0] {
  return {
    demand: 100, expectedSupply: 70, shortage: 30, coverageRate: 70, daysToRequired: 5,
    startedVelocityPerDay: 2, expectedDaysToCloseGap: 15, expectedExits: 5, returningPool: 20,
    pipelineAvailable: false, pipelineExpectedStart: 0, conversionRate: 0.4, confidenceLevel: "MEDIUM", ...over,
  };
}

test("1. Demand calculation only sums available components", () => {
  const demand = calculateDemand([
    { source: "PLANNING", value: 100, available: true, provenance: { system: "PLANNING", recordCount: 1, lastUpdatedAt: null, certainty: "CONFIRMED" } },
    { source: "RECRUITMENT_REQUEST", value: 999, available: false, provenance: { system: "RECRUITMENT_REQUEST", recordCount: 0, lastUpdatedAt: null, certainty: "UNAVAILABLE" } },
  ]);
  assert.equal(demand.total, 100);
});

test("2. Supply formula includes incoming/returning/transfers and subtracts exits/out", () => {
  const supply = calculateSupply({ currentActive: 100, confirmedIncoming: 10, expectedReturning: 5, transferIn: 3, expectedExits: 8, transferOut: 2 });
  assert.equal(supply.expectedSupply, 108);
});

test("3. Gap convention is supply - demand; shortage/surplus are explicit", () => {
  assert.deepEqual(calculateGap(350, 265), { demand: 350, expectedSupply: 265, gap: -85, shortage: 85, surplus: 0, coverageRate: 75.7 });
  assert.equal(calculateGap(100, 120).surplus, 20);
});

test("4. Coverage is null when demand is zero (no divide-by-zero fiction)", () => {
  assert.equal(calculateGap(0, 20).coverageRate, null);
});

test("5. Expected exit reduces supply on its effective date", () => {
  const forecast = buildForecast({ from: "2026-09-01", to: "2026-09-03", currentActive: 100, demandRecords: [DEMAND], supplyEvents: [{ departmentId: "d1", effectiveDate: "2026-09-02", type: "EXPECTED_EXIT", quantity: 10 }], confidence: CONFIDENCE });
  assert.equal(forecast.points[0].expectedSupply, 100);
  assert.equal(forecast.points[1].expectedSupply, 90);
});

test("6. Transfer in/out components are deterministic", () => {
  const forecast = buildForecast({ from: "2026-09-01", to: "2026-09-02", currentActive: 100, demandRecords: [DEMAND], supplyEvents: [
    { departmentId: "d1", effectiveDate: "2026-09-02", type: "TRANSFER_IN", quantity: 7 },
    { departmentId: "d1", effectiveDate: "2026-09-02", type: "TRANSFER_OUT", quantity: 2 },
  ], confidence: CONFIDENCE });
  assert.equal(forecast.points[1].transferIn, 7);
  assert.equal(forecast.points[1].transferOut, 2);
  assert.equal(forecast.points[1].expectedSupply, 105);
});

test("7. Returning supply is only counted when represented by an explicit event", () => {
  const none = buildForecast({ from: "2026-09-01", to: "2026-09-01", currentActive: 50, demandRecords: [DEMAND], supplyEvents: [], confidence: CONFIDENCE });
  const confirmed = buildForecast({ from: "2026-09-01", to: "2026-09-01", currentActive: 50, demandRecords: [DEMAND], supplyEvents: [{ departmentId: "d1", effectiveDate: "2026-09-01", type: "EXPECTED_RETURNING", quantity: 10 }], confidence: CONFIDENCE });
  assert.equal(none.points[0].expectedReturning, 0);
  assert.equal(confirmed.points[0].expectedReturning, 10);
});

test("8. Conversion engine computes the complete funnel", () => {
  const c = calculateConversion(100, 70, 56);
  assert.equal(c.applicationToApproved, 0.7);
  assert.equal(c.approvedToStarted, 0.8);
  assert.equal(c.applicationToStarted, 0.56);
});

test("9. Required applications uses deterministic conversion and safety buffer", () => {
  assert.equal(calculateRequiredApplications(85, 0.56, 0).requiredAdditionalApplications, 152);
  assert.equal(calculateRequiredApplications(85, 0.56, 10).requiredAdditionalApplications, 167);
  assert.equal(calculateRequiredApplications(85, null, 10).requiredAdditionalApplications, null);
});

test("10. Risk score maps deterministically to CRITICAL", () => {
  const risk = assessRisk(riskInput({ coverageRate: 60, expectedSupply: 60, shortage: 40, daysToRequired: 2, startedVelocityPerDay: 0, confidenceLevel: "LOW" }));
  assert.equal(risk.level, "CRITICAL");
  assert.ok(risk.score >= 75);
});

test("11. Risk explanation contains factor contribution and evidence", () => {
  const risk = assessRisk(riskInput());
  const coverage = risk.factors.find((f) => f.key === "LOW_COVERAGE");
  assert.ok(coverage);
  assert.ok((coverage?.contribution ?? 0) > 0);
  assert.equal(coverage?.evidence.coverageRate, 70);
});

test("12. Scope null means unrestricted", () => {
  assert.equal(canAccessDepartment(null, "d1"), true);
  assert.equal(restrictDepartmentIds(null, null), null);
});

test("13. Empty scope means no data", () => {
  assert.deepEqual(restrictDepartmentIds([], null), []);
  assert.equal(canAccessDepartment([], "d1"), false);
});

test("14. Department scope only permits assigned department", () => {
  assert.deepEqual(restrictDepartmentIds(["d1"], "d1"), ["d1"]);
  assert.deepEqual(restrictDepartmentIds(["d1"], "d2"), []);
});

test("15. AI tool department cannot widen scope", () => {
  assert.equal(resolveAuthorizedToolDepartment(["packing"], "harvest"), null);
  assert.equal(resolveAuthorizedToolDepartment(["packing"], "packing"), "packing");
});

test("16. Missing critical sources lowers forecast confidence", () => {
  const c = calculateForecastConfidence({ demandAvailable: false, currentSupplyAvailable: false, confirmedDataRatio: 0, historicalSampleSize: 0, volatility: null, horizonDays: 30, missingCriticalSources: ["ATS", "HRIS"], staleSources: [] });
  assert.equal(c.level, "LOW");
  assert.ok(c.warnings.some((w) => w.includes("ATS")));
});

test("17. Stale external source detection handles missing and old sync", () => {
  assert.equal(isSourceStale(null, "2026-08-15T12:00:00Z", 24), true);
  assert.equal(isSourceStale("2026-08-13T00:00:00Z", "2026-08-15T12:00:00Z", 24), true);
  assert.equal(isSourceStale("2026-08-15T11:00:00Z", "2026-08-15T12:00:00Z", 24), false);
});

test("18. Forecast becomes LOW confidence for an estimated scenario", () => {
  const baseline = buildForecast({ from: "2026-09-01", to: "2026-09-02", currentActive: 70, demandRecords: [DEMAND], supplyEvents: [], confidence: CONFIDENCE });
  const scenario = applyScenarioToForecast(baseline, { targetDepartmentId: "d1", additionalIncoming: 10 }, 2);
  assert.equal(scenario.confidence.level, "LOW");
});

test("19. Superseded and non-active Planning versions are never double-counted", () => {
  const rows: DemandRecord[] = [
    DEMAND,
    { ...DEMAND, id: "old", value: 80, status: "EXPIRED", supersededBy: "p1" },
    { ...DEMAND, id: "draft", value: 50, status: "DRAFT" },
  ];
  assert.deepEqual(filterEffectiveDemandRecords(rows).map((r) => r.id), ["p1"]);
});

test("20. Scenario is read-only and does not mutate baseline forecast", () => {
  const baseline = buildForecast({ from: "2026-09-01", to: "2026-09-02", currentActive: 70, demandRecords: [DEMAND], supplyEvents: [], confidence: CONFIDENCE });
  const before = structuredClone(baseline);
  const scenario = applyScenarioToForecast(baseline, { targetDepartmentId: "d1", additionalIncoming: 20, retainedExpectedExits: 5 }, 1);
  assert.deepEqual(baseline, before);
  assert.notDeepEqual(scenario, baseline);
});

test("21. Recruitment velocity warns on low sample and calculates days to close", () => {
  const v = calculateVelocity({ applications: 20, approved: 10, started: 6, observationDays: 30, shortage: 12 });
  assert.equal(v.startedPerDay, 0.2);
  assert.equal(v.expectedDaysToCloseGap, 60);
  assert.ok(v.warning);
});

test("22. Action engine only returns evidence-backed candidates", () => {
  const risk = assessRisk(riskInput());
  const actions = recommendActions({ department: { id: "d1", name: "Packing" }, shortage: 30, coverageRate: 70, firstRiskDate: "2026-09-05", daysToRequired: 5, returningPool: 10, expectedExits: 5, availableInternalSurplus: 0, requiredAdditionalApplications: 75, topReferralSource: "Giới thiệu", conversionRate: 0.4, risk });
  assert.ok(actions.some((a) => a.actionKey === "ACCELERATE_RECRUITMENT"));
  assert.ok(actions.every((a) => a.evidence.length > 0));
});

test("23. Aggregate forecast recomputes gap from total demand and supply", () => {
  const a = buildForecast({ from: "2026-09-01", to: "2026-09-01", currentActive: 40, demandRecords: [{ ...DEMAND, value: 60 }], supplyEvents: [], confidence: CONFIDENCE });
  const b = buildForecast({ from: "2026-09-01", to: "2026-09-01", currentActive: 80, demandRecords: [{ ...DEMAND, departmentId: "d2", value: 70 }], supplyEvents: [], confidence: CONFIDENCE });
  const total = aggregateForecasts([a, b], CONFIDENCE);
  assert.equal(total.points[0].demand, 130);
  assert.equal(total.points[0].expectedSupply, 120);
  assert.equal(total.points[0].gap, -10);
});

test("24. Recruitment Request contract requires canonical department and coherent totals", () => {
  const record: RecruitmentDemand = {
    sourceSystem: "RECRUITMENT_REQUEST", externalRecordId: "r1", externalRequestId: "r1",
    effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30", lastUpdatedAt: "2026-08-15T00:00:00Z",
    locationId: null, divisionId: null, departmentId: "", sectionId: null, groupId: null, positionId: null,
    requiredMale: 10, requiredFemale: 10, requiredTotal: 25, priority: "HIGH", requestReason: null,
    status: "APPROVED", requestedAt: "2026-08-14T00:00:00Z", approvedAt: null, updatedAt: "2026-08-15T00:00:00Z",
    logicalDemandKey: "packing-sep", supersedesDemandKey: null,
  };
  const result = validateRecruitmentDemand(record);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.length >= 3);
});

/* ---------------- Production hardening matrix ---------------- */

test("Planning A: Original 100 produces daily requirement 100, not 100 × days", () => {
  const forecast = buildForecast({ from: "2026-09-01", to: "2026-09-10", currentActive: 0, demandRecords: [DEMAND], supplyEvents: [], confidence: CONFIDENCE });
  assert.equal(forecast.points.length, 10);
  assert.ok(forecast.points.every((point) => point.demand === 100));
});

test("Planning B: Original 100 + authorized Supplement 20 = 120", () => {
  const forecast = buildForecast({ from: "2026-09-01", to: "2026-09-01", currentActive: 0, demandRecords: [DEMAND, { ...DEMAND, id: "supplement", value: 20 }], supplyEvents: [], confidence: CONFIDENCE });
  assert.equal(forecast.points[0].demand, 120);
});

test("Planning C: superseded v1=100 + active v2=130 = 130, not 230", () => {
  const records = [{ ...DEMAND, id: "v1", status: "EXPIRED", supersededBy: "v2" }, { ...DEMAND, id: "v2", value: 130 }];
  const forecast = buildForecast({ from: "2026-09-01", to: "2026-09-01", currentActive: 0, demandRecords: records, supplyEvents: [], confidence: CONFIDENCE });
  assert.equal(forecast.points[0].demand, 130);
});

test("Planning D: active v2=130 + Supplement 20 = 150", () => {
  const records = [{ ...DEMAND, id: "v2", value: 130 }, { ...DEMAND, id: "supplement", value: 20 }];
  assert.equal(buildForecast({ from: "2026-09-01", to: "2026-09-01", currentActive: 0, demandRecords: records, supplyEvents: [], confidence: CONFIDENCE }).points[0].demand, 150);
});

test("Planning E: expired/out-of-effective-date period is not counted", () => {
  const forecast = buildForecast({ from: "2026-10-01", to: "2026-10-02", currentActive: 0, demandRecords: [DEMAND], supplyEvents: [], confidence: CONFIDENCE });
  assert.ok(forecast.points.every((point) => point.demand === 0));
});

test("Planning F: overlapping independent authorized periods are additive on overlap only", () => {
  const second = { ...DEMAND, id: "independent", startDate: "2026-09-05", endDate: "2026-09-07", value: 30 };
  const points = buildForecast({ from: "2026-09-04", to: "2026-09-08", currentActive: 0, demandRecords: [DEMAND, second], supplyEvents: [], confidence: CONFIDENCE }).points;
  assert.deepEqual(points.map((p) => p.demand), [100, 130, 130, 130, 100]);
});

test("daily forecast aggregates multiple departments without multiplying daily demand", () => {
  const packing = buildForecast({ from: "2026-09-01", to: "2026-09-02", currentActive: 90, demandRecords: [DEMAND], supplyEvents: [], confidence: CONFIDENCE });
  const harvest = buildForecast({ from: "2026-09-01", to: "2026-09-02", currentActive: 40, demandRecords: [{ ...DEMAND, departmentId: "d2", value: 50 }], supplyEvents: [], confidence: CONFIDENCE });
  assert.deepEqual(aggregateForecasts([packing, harvest], CONFIDENCE).points.map((p) => p.demand), [150, 150]);
});

test("incoming, resignation and transfer apply exactly from their effective dates", () => {
  const points = buildForecast({
    from: "2026-09-01", to: "2026-09-05", currentActive: 100, demandRecords: [DEMAND], confidence: CONFIDENCE,
    supplyEvents: [
      { departmentId: "d1", effectiveDate: "2026-09-02", type: "CONFIRMED_INCOMING", quantity: 10 },
      { departmentId: "d1", effectiveDate: "2026-09-03", type: "EXPECTED_EXIT", quantity: 5 },
      { departmentId: "d1", effectiveDate: "2026-09-04", type: "TRANSFER_OUT", quantity: 3 },
      { departmentId: "d1", effectiveDate: "2026-09-05", type: "TRANSFER_IN", quantity: 2 },
    ],
  }).points;
  assert.deepEqual(points.map((p) => p.expectedSupply), [100, 110, 105, 102, 104]);
});

test("recorded current and confirmed incoming are mutually exclusive by date", () => {
  const base = { workerId: "w1", status: "APPROVED", regDate: "2026-08-15", endDate: null, workerProfileAvailable: true, workerProfileDeleted: false };
  const future = { ...base, startingDate: "2026-09-01" };
  assert.equal(isRecordedCurrentWorkforce(future, "2026-08-15"), false);
  assert.equal(isConfirmedIncoming(future, "2026-08-15", "2026-09-30"), true);
  assert.equal(isConfirmedIncoming({ ...future, status: "REJECTED" }, "2026-08-15", "2026-09-30"), false);
  assert.equal(isConfirmedIncoming({ ...future, endDate: "2026-08-31" }, "2026-08-15", "2026-09-30"), false);
});

test("orphan/deleted worker session is never recorded current workforce", () => {
  const session = { workerId: "w1", status: "APPROVED", regDate: "2026-08-01", startingDate: null, endDate: null, workerProfileAvailable: false, workerProfileDeleted: false };
  assert.equal(isRecordedCurrentWorkforce(session, "2026-08-15"), false);
  assert.equal(isRecordedCurrentWorkforce({ ...session, workerProfileAvailable: true, workerProfileDeleted: true }, "2026-08-15"), false);
});

test("expected exit semantics include confirmed status only, never PENDING_HR", () => {
  assert.equal(isConfirmedResignationStatus("INACTIVE"), true);
  assert.equal(isConfirmedResignationStatus("PENDING_HR"), false);
  assert.equal(isConfirmedResignationStatus("REJECTED"), false);
});

test("gap/coverage edge matrix never returns Infinity or NaN", () => {
  assert.deepEqual(calculateGap(0, 0), { demand: 0, expectedSupply: 0, gap: 0, shortage: 0, surplus: 0, coverageRate: null });
  assert.deepEqual(calculateGap(0, 10), { demand: 0, expectedSupply: 10, gap: 10, shortage: 0, surplus: 10, coverageRate: null });
  assert.equal(calculateGap(10, 0).coverageRate, 0);
  assert.equal(calculateGap(10, 15).gap, 5);
  assert.equal(calculateGap(10, 5).gap, -5);
});

test("required applications is null for zero conversion, low sample or LOW confidence", () => {
  assert.equal(calculateRequiredApplications(10, 0).requiredAdditionalApplications, null);
  assert.equal(calculateRequiredApplications(10, 0.5, 10, { sampleSize: 12 }).requiredAdditionalApplications, null);
  assert.equal(calculateRequiredApplications(10, 0.5, 10, { sampleSize: 100, confidenceLevel: "LOW" }).requiredAdditionalApplications, null);
  const estimate = calculateRequiredApplications(10, 0.5, 10, { sampleSize: 100, confidenceLevel: "MEDIUM" });
  assert.equal(estimate.requiredAdditionalApplications, 22);
  assert.match(estimate.warning ?? "", /Ước tính có điều kiện/);
});

test("velocity uses completed calendar-day denominator and no days-to-close at zero velocity", () => {
  const zero = calculateVelocity({ applications: 0, approved: 0, started: 0, observationDays: 30, shortage: 10 });
  assert.equal(zero.dayBasis, "COMPLETED_CALENDAR_DAYS");
  assert.equal(zero.includesIncompleteCurrentDay, false);
  assert.equal(zero.expectedDaysToCloseGap, null);
  assert.equal(calculateVelocity({ applications: 1, approved: 1, started: 1, observationDays: 1, shortage: 2 }).startedPerDay, 1);
});

test("risk calibration: zero demand/no data cannot be CRITICAL", () => {
  const risk = assessRisk(riskInput({ demand: 0, expectedSupply: 0, shortage: 0, coverageRate: null, confidenceLevel: "LOW", expectedExits: 0 }));
  assert.deepEqual(risk, { score: 0, level: "LOW", factors: [] });
});

test("risk calibration: tiny low-coverage shortage is capped below CRITICAL", () => {
  const risk = assessRisk(riskInput({ demand: 2, expectedSupply: 0, shortage: 2, coverageRate: 0, daysToRequired: 1, startedVelocityPerDay: 0, expectedExits: 0, confidenceLevel: "LOW" }));
  assert.ok(risk.score < 75);
});

test("risk calibration: score always clamps 0–100", () => {
  const risk = assessRisk(riskInput({ demand: 1000, expectedSupply: 0, shortage: 1000, coverageRate: 0, daysToRequired: 0, startedVelocityPerDay: 0, expectedExits: 1000, pipelineAvailable: true, pipelineExpectedStart: 0, conversionRate: 0, confidenceLevel: "LOW" }));
  assert.equal(risk.score, 100);
});

test("action safety: transfer/returning require evidence and supply shortage does not open supplement", () => {
  const risk = assessRisk(riskInput());
  const noEvidence = recommendActions({ department: { id: "d1", name: "Packing" }, shortage: 20, coverageRate: 80, firstRiskDate: "2026-09-01", daysToRequired: 10, returningPool: 0, expectedExits: 0, availableInternalSurplus: 0, requiredAdditionalApplications: null, topReferralSource: null, conversionRate: null, risk });
  assert.equal(noEvidence.some((a) => a.actionKey === "TRANSFER_INTERNAL_WORKFORCE"), false);
  assert.equal(noEvidence.some((a) => a.actionKey === "REACTIVATE_RETURNING_WORKERS"), false);
  assert.equal(noEvidence.some((a) => a.actionKey === "OPEN_SUPPLEMENT_REQUEST"), false);
  const evidence = recommendActions({ department: { id: "d1", name: "Packing" }, shortage: 20, coverageRate: 80, firstRiskDate: "2026-09-01", daysToRequired: 10, returningPool: 3, expectedExits: 0, availableInternalSurplus: 5, requiredAdditionalApplications: null, topReferralSource: null, conversionRate: null, risk });
  assert.ok(evidence.some((a) => a.actionKey === "TRANSFER_INTERNAL_WORKFORCE"));
  assert.ok(evidence.some((a) => a.actionKey === "REACTIVATE_RETURNING_WORKERS"));
});

test("analytics diagnostics expose incomplete worker/session identity and reduce confidence", () => {
  const diagnostics = buildAnalyticsCompleteness({ applications: 100, applicationsWithoutSession: 20, sessionsWithoutWorker: 2, sessionsWithDeletedWorker: 1, sessionsWithoutApplication: 3, workersWithoutSession: 4, missingApplicationDepartment: 5, missingSessionDepartment: 2, duplicateActiveWorkerProfiles: 1 });
  assert.equal(diagnostics.completenessRate, 80);
  assert.ok(diagnostics.warnings.length >= 7);
  assert.ok(completenessConfirmedRatio(diagnostics) < 0.8);
});

test("scenario input rejects negative/absurd values and labels remain bounded", () => {
  assert.equal(parseScenarioOverrides({ targetDepartmentId: "6f9619ff-8b86-d011-b42d-00c04fc964ff", additionalIncoming: -1 }).ok, false);
  assert.equal(parseScenarioOverrides({ targetDepartmentId: "6f9619ff-8b86-d011-b42d-00c04fc964ff", additionalIncoming: 10001 }).ok, false);
  assert.equal(parseScenarioOverrides({ targetDepartmentId: "6f9619ff-8b86-d011-b42d-00c04fc964ff", recruitmentVelocityMultiplier: 3.1 }).ok, false);
  assert.equal(parseScenarioOverrides({ targetDepartmentId: "6f9619ff-8b86-d011-b42d-00c04fc964ff", additionalIncoming: 10 }).ok, true);
});

test("scenario route has no business/audit write and service labels SIMULATION", async () => {
  const fs = await import("node:fs/promises");
  const route = await fs.readFile(new URL("../../app/api/workforce-intelligence/scenario/route.ts", import.meta.url), "utf8");
  const service = await fs.readFile(new URL("./service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /writeAudit|\.insert\(|\.update\(|\.delete\(/);
  assert.match(service, /mode: scenario \? "SIMULATION" : null/);
});
