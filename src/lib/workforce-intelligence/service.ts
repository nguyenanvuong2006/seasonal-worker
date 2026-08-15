import "server-only";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db, pool } from "@/db";
import { departments, planningPeriods, planningTargets } from "@/db/schema";
import { getUserScope, type Session } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { recommendActions } from "./actions.ts";
import {
  addDateDays,
  aggregateForecasts,
  applyScenarioToForecast,
  buildForecast,
  calculateConversion,
  calculateForecastConfidence,
  calculateGap,
  calculateRequiredApplications,
  calculateSupply,
  calculateVelocity,
  daysBetween,
  type DemandRecord,
  type SupplyEvent,
} from "./calculations.ts";
import { assessRisk } from "./risk.ts";
import { buildAnalyticsCompleteness, completenessConfirmedRatio, type AnalyticsCompleteness } from "./diagnostics.ts";
import { WORKFORCE_STATUS_SEMANTICS } from "./semantics.ts";
import { restrictDepartmentIds } from "./scope.ts";
import type {
  DepartmentIntelligence,
  ForecastPoint,
  OutlookFilters,
  PipelineSupply,
  RecommendedAction,
  ScenarioOverrides,
  WorkforceDemand,
  WorkforceIntelligenceOverview,
  WorkforceSupply,
} from "./types.ts";
import type { IntegrationSourceStatus } from "../integrations/types.ts";

const HISTORICAL_DAYS = 30;
const PIPELINE_UNAVAILABLE: PipelineSupply = {
  available: false,
  applied: null,
  screened: null,
  shortlisted: null,
  interview: null,
  offered: null,
  accepted: null,
  onboarding: null,
  expectedStart: null,
  probabilityWeightedSupply: null,
  message: "ATS chưa được tích hợp; pipeline không được giả lập và không được cộng vào supply.",
};

export class WorkforceScopeError extends Error {
  constructor() {
    super("Bộ phận yêu cầu nằm ngoài Data Scope được phép xem.");
    this.name = "WorkforceScopeError";
  }
}

type UnknownRow = Record<string, unknown>;
type DeptRow = {
  id: string;
  deptName: string;
  groupName: string | null;
  location: string | null;
  division: string | null;
};

type PlanningRow = {
  id: string;
  departmentId: string;
  startDate: string;
  endDate: string;
  status: string;
  supersededBy: string | null;
  updatedAt: Date;
  demandMale: number | null;
  demandFemale: number | null;
  targetCount: number | null;
};

type DepartmentDraft = DepartmentIntelligence & { topReferralSource: string | null };

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestIso(values: (string | null)[]): string | null {
  return values.filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
}

function valueAtCriticalDate(points: ForecastPoint[]): ForecastPoint {
  if (points.length === 0) {
    return {
      date: "",
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
  }
  return [...points].sort((a, b) => {
    if (b.shortage !== a.shortage) return b.shortage - a.shortage;
    if (b.demand !== a.demand) return b.demand - a.demand;
    return a.date.localeCompare(b.date);
  })[0];
}

function demandValue(row: PlanningRow): number {
  const byGender = n(row.demandMale) + n(row.demandFemale);
  return byGender > 0 ? byGender : n(row.targetCount);
}

function buildDemand(point: ForecastPoint, rows: PlanningRow[]): WorkforceDemand {
  const activeAtDate = rows.filter((r) => r.startDate <= point.date && r.endDate >= point.date);
  return {
    total: point.demand,
    components: [
      {
        source: "PLANNING",
        value: point.demand,
        available: true,
        provenance: {
          system: "PLANNING",
          recordCount: activeAtDate.length,
          lastUpdatedAt: latestIso(activeAtDate.map((r) => iso(r.updatedAt))),
          certainty: "CONFIRMED",
        },
      },
      {
        source: "RECRUITMENT_REQUEST",
        value: null,
        available: false,
        provenance: {
          system: "RECRUITMENT_REQUEST",
          recordCount: null,
          lastUpdatedAt: null,
          certainty: "UNAVAILABLE",
        },
      },
    ],
  };
}

function buildSupply(point: ForecastPoint): WorkforceSupply {
  return calculateSupply({
    currentActive: point.currentSupply,
    confirmedIncoming: point.expectedIncoming,
    expectedReturning: point.expectedReturning,
    transferIn: point.transferIn,
    expectedExits: point.expectedExit,
    transferOut: point.transferOut,
    provenance: [
      { system: "SEASONAL_WORKER", recordCount: point.recordedCurrentWorkforce, lastUpdatedAt: null, certainty: "RECORDED" },
      { system: "SEASONAL_WORKER", recordCount: point.expectedIncoming, lastUpdatedAt: null, certainty: "CONFIRMED" },
      { system: "WORKFORCE_MOVEMENT", recordCount: point.expectedExit + point.transferIn + point.transferOut, lastUpdatedAt: null, certainty: "CONFIRMED" },
      { system: "HRIS", recordCount: null, lastUpdatedAt: null, certainty: "UNAVAILABLE" },
    ],
  });
}

function sourceStatuses(generatedAt: string): IntegrationSourceStatus[] {
  return [
    {
      sourceSystem: "SEASONAL_WORKER",
      status: "CURRENT",
      lastSyncAt: generatedAt,
      lastSuccessfulSyncAt: generatedAt,
      message: "Đọc trực tiếp database Seasonal Worker tại thời điểm tạo outlook.",
    },
    {
      sourceSystem: "PLANNING",
      status: "CURRENT",
      lastSyncAt: generatedAt,
      lastSuccessfulSyncAt: generatedAt,
      message: "Demand chỉ lấy Planning ACTIVE chưa bị supersede.",
    },
    { sourceSystem: "RECRUITMENT_REQUEST", status: "UNAVAILABLE", lastSyncAt: null, lastSuccessfulSyncAt: null, message: "Chưa có connector." },
    { sourceSystem: "ATS", status: "UNAVAILABLE", lastSyncAt: null, lastSuccessfulSyncAt: null, message: "Chưa có connector; pipeline supply không được giả lập." },
    { sourceSystem: "HRIS", status: "UNAVAILABLE", lastSyncAt: null, lastSuccessfulSyncAt: null, message: "Chưa có connector." },
    { sourceSystem: "ATTENDANCE", status: "UNAVAILABLE", lastSyncAt: null, lastSuccessfulSyncAt: null, message: "Chưa có connector; current active dựa trên employment sessions." },
  ];
}

function actionRank(action: RecommendedAction): number {
  return action.priority === "URGENT" ? 4 : action.priority === "HIGH" ? 3 : action.priority === "MEDIUM" ? 2 : 1;
}

function emptyOverview(filters: OutlookFilters, restricted: boolean, outOfScope: boolean, generatedAt: string): WorkforceIntelligenceOverview {
  const confidence = calculateForecastConfidence({
    demandAvailable: false,
    currentSupplyAvailable: false,
    confirmedDataRatio: 0,
    historicalSampleSize: 0,
    volatility: null,
    horizonDays: daysBetween(filters.from, filters.to) + 1,
    missingCriticalSources: ["ATS", "HRIS", "ATTENDANCE"],
    staleSources: [],
  });
  const forecast = { points: [], firstRiskDate: null, peakShortageDate: null, peakShortage: 0, confidence };
  const gap = calculateGap(0, 0);
  const conversion = calculateConversion(0, 0, 0);
  const velocity = calculateVelocity({ applications: 0, approved: 0, started: 0, observationDays: HISTORICAL_DAYS, shortage: 0 });
  const diagnostics = buildAnalyticsCompleteness({
    applications: 0,
    applicationsWithoutSession: 0,
    sessionsWithoutWorker: 0,
    sessionsWithDeletedWorker: 0,
    sessionsWithoutApplication: 0,
    workersWithoutSession: restricted ? null : 0,
    missingApplicationDepartment: restricted ? null : 0,
    missingSessionDepartment: restricted ? null : 0,
    duplicateActiveWorkerProfiles: 0,
  });
  return {
    generatedAt,
    period: { from: filters.from, to: filters.to, label: `Next ${daysBetween(filters.from, filters.to) + 1} days` },
    scope: {
      restricted,
      departmentCount: 0,
      note: restricted ? "Trong phạm vi dữ liệu bạn có quyền xem." : "Phạm vi toàn bộ dữ liệu được cấp quyền.",
    },
    outOfScope,
    asOfDate: filters.from,
    demand: buildDemand({ ...valueAtCriticalDate([]), date: filters.from }, []),
    supply: buildSupply({ ...valueAtCriticalDate([]), date: filters.from }),
    gap,
    forecast,
    risk: assessRisk({
      demand: 0,
      expectedSupply: 0,
      shortage: 0,
      coverageRate: null,
      daysToRequired: null,
      startedVelocityPerDay: 0,
      expectedDaysToCloseGap: 0,
      expectedExits: 0,
      returningPool: 0,
      pipelineAvailable: false,
      pipelineExpectedStart: 0,
      conversionRate: null,
      confidenceLevel: confidence.level,
    }),
    conversion,
    requiredApplications: calculateRequiredApplications(0, null),
    velocity,
    referralPerformance: [],
    returningWorkerOpportunity: 0,
    expectedExits: 0,
    diagnostics,
    pipeline: { ...PIPELINE_UNAVAILABLE },
    departments: [],
    recommendedActions: [],
    sources: sourceStatuses(generatedAt),
    dataFreshnessWarnings: ["ATS, HRIS và Attendance chưa được tích hợp."],
    scenario: { applied: false, mode: null, overrides: null, classification: null },
  };
}

/**
 * Central read-only aggregation service. It is the only DB-facing entry used by
 * Workforce Intelligence API/tools; every call derives scope from the Session.
 */
export async function getWorkforceIntelligence(
  session: Session,
  filters: OutlookFilters,
  scenario: ScenarioOverrides | null = null,
): Promise<WorkforceIntelligenceOverview> {
  const generatedAt = new Date().toISOString();
  const today = todayStr();
  const scope = await getUserScope(session);
  const restriction = restrictDepartmentIds(scope, filters.departmentId);
  const outOfScope = Boolean(filters.departmentId && restriction !== null && restriction.length === 0);
  if (outOfScope) return emptyOverview(filters, scope !== null, true, generatedAt);
  if (restriction !== null && restriction.length === 0) return emptyOverview(filters, true, false, generatedAt);

  const deptConditions = [isNull(departments.deletedAt), eq(departments.isActive, true)];
  if (restriction !== null) deptConditions.push(inArray(departments.id, restriction));
  const deptRows: DeptRow[] = await db
    .select({
      id: departments.id,
      deptName: departments.deptName,
      groupName: departments.groupName,
      location: departments.location,
      division: departments.division,
    })
    .from(departments)
    .where(and(...deptConditions));

  if (deptRows.length === 0) return emptyOverview(filters, scope !== null, false, generatedAt);
  const deptIds = deptRows.map((d) => d.id);
  if (scenario && !deptIds.includes(scenario.targetDepartmentId)) throw new WorkforceScopeError();

  const planningConditions = [
    eq(planningPeriods.status, "ACTIVE"),
    isNull(planningPeriods.supersededBy),
    lte(planningPeriods.startDate, filters.to),
    gte(planningPeriods.endDate, filters.from),
    inArray(planningPeriods.departmentId, deptIds),
  ];

  // Velocity/conversion use the last 30 completed calendar days. Excluding today avoids
  // depressing rates simply because the current day is still incomplete.
  const historicalToStr = addDateDays(today, -1);
  const historicalFromStr = addDateDays(today, -HISTORICAL_DAYS);

  const [
    planningRowsRaw,
    currentRes,
    incomingRes,
    movementRes,
    returningRes,
    funnelRes,
    referralRes,
    applicationDiagnosticsRes,
    sessionDiagnosticsRes,
    globalDiagnosticsRes,
  ] = await Promise.all([
    db
      .select({
        id: planningPeriods.id,
        departmentId: planningPeriods.departmentId,
        startDate: planningPeriods.startDate,
        endDate: planningPeriods.endDate,
        status: planningPeriods.status,
        supersededBy: planningPeriods.supersededBy,
        updatedAt: planningPeriods.updatedAt,
        demandMale: planningTargets.demandMale,
        demandFemale: planningTargets.demandFemale,
        targetCount: planningTargets.targetCount,
      })
      .from(planningPeriods)
      .leftJoin(planningTargets, eq(planningTargets.planningPeriodId, planningPeriods.id))
      .where(and(...planningConditions)),
    pool.query(
      `WITH ranked AS (
         SELECT es.*, row_number() OVER (PARTITION BY es.worker_id ORDER BY es.reg_date DESC, es.created_at DESC, es.id DESC) AS rn
         FROM employment_sessions es
         JOIN worker_profiles wp ON wp.id = es.worker_id AND wp.deleted_at IS NULL
       )
       SELECT dept_id, count(*)::int AS current_active
       FROM ranked
       WHERE rn = 1 AND dept_id = ANY($1::uuid[]) AND status = '${WORKFORCE_STATUS_SEMANTICS.recordedWorkforce.activeEmploymentSession}'
         AND coalesce(starting_date, reg_date) <= $2::date
         AND (end_date IS NULL OR end_date > $2::date)
       GROUP BY dept_id`,
      [deptIds, today],
    ),
    pool.query(
      `WITH ranked AS (
         SELECT es.*, row_number() OVER (PARTITION BY es.worker_id ORDER BY es.reg_date DESC, es.created_at DESC, es.id DESC) AS rn
         FROM employment_sessions es
         JOIN worker_profiles wp ON wp.id = es.worker_id AND wp.deleted_at IS NULL
       )
       SELECT dept_id, to_char(starting_date, 'YYYY-MM-DD') AS effective_date, count(*)::int AS c
       FROM ranked
       WHERE rn = 1 AND dept_id = ANY($1::uuid[]) AND status = '${WORKFORCE_STATUS_SEMANTICS.recordedWorkforce.activeEmploymentSession}'
         AND starting_date > $2::date AND starting_date <= $3::date
         AND (end_date IS NULL OR end_date >= starting_date)
       GROUP BY dept_id, starting_date`,
      [deptIds, today, filters.to],
    ),
    pool.query(
      `WITH latest_session AS (
         SELECT es.*, row_number() OVER (PARTITION BY es.worker_id ORDER BY es.reg_date DESC, es.created_at DESC, es.id DESC) AS rn
         FROM employment_sessions es
         JOIN worker_profiles wp ON wp.id = es.worker_id AND wp.deleted_at IS NULL
       ), relevant AS (
         SELECT DISTINCT ON (m.movement_type, m.worker_id)
                m.movement_type, m.status, m.effective_date, m.from_dept_id, m.to_dept_id,
                m.worker_id, m.updated_at
         FROM workforce_movements m
         JOIN latest_session ls ON ls.worker_id = m.worker_id AND ls.rn = 1
         WHERE m.effective_date > $2::date AND m.effective_date <= $3::date
           AND (m.from_dept_id = ANY($1::uuid[]) OR m.to_dept_id = ANY($1::uuid[]))
           AND ls.status = '${WORKFORCE_STATUS_SEMANTICS.recordedWorkforce.activeEmploymentSession}' AND coalesce(ls.starting_date, ls.reg_date) <= $2::date
           AND (ls.end_date IS NULL OR ls.end_date > $2::date)
           AND ((m.movement_type = 'resignation' AND m.status = ANY($4::text[]) AND ls.dept_id = m.from_dept_id)
             OR (m.movement_type = 'transfer' AND m.status = ANY($5::text[]) AND ls.dept_id = m.to_dept_id))
         ORDER BY m.movement_type, m.worker_id, m.updated_at DESC, m.id DESC
       )
       SELECT movement_type, status, to_char(effective_date, 'YYYY-MM-DD') AS effective_date,
              from_dept_id, to_dept_id, count(*)::int AS c, max(updated_at) AS last_updated_at
       FROM relevant
       GROUP BY movement_type, status, effective_date, from_dept_id, to_dept_id`,
      [
        deptIds,
        today,
        filters.to,
        [...WORKFORCE_STATUS_SEMANTICS.movement.confirmedResignation],
        [...WORKFORCE_STATUS_SEMANTICS.movement.confirmedTransfer],
      ],
    ),
    pool.query(
      `SELECT h.dept_id, count(DISTINCT h.worker_id)::int AS c
       FROM employment_sessions h
       JOIN worker_profiles wp ON wp.id = h.worker_id AND wp.deleted_at IS NULL
       WHERE h.dept_id = ANY($1::uuid[])
         AND (h.end_date IS NOT NULL OR h.status = 'INACTIVE')
         AND NOT EXISTS (
           SELECT 1 FROM employment_sessions a
           WHERE a.worker_id = h.worker_id AND a.status = '${WORKFORCE_STATUS_SEMANTICS.recordedWorkforce.activeEmploymentSession}'
             AND coalesce(a.starting_date, a.reg_date) <= $2::date
             AND (a.end_date IS NULL OR a.end_date > $2::date)
         )
       GROUP BY h.dept_id`,
      [deptIds, today],
    ),
    pool.query(
      `SELECT a.dept_id,
              count(DISTINCT a.id)::int AS applications,
              count(DISTINCT a.id) FILTER (WHERE a.status = '${WORKFORCE_STATUS_SEMANTICS.recordedWorkforce.activeEmploymentSession}' OR es.starting_date IS NOT NULL)::int AS approved,
              count(DISTINCT a.id) FILTER (WHERE es.starting_date IS NOT NULL AND es.starting_date <= $3::date)::int AS started,
              max(a.updated_at) AS last_updated_at
       FROM daily_applications a
       LEFT JOIN employment_sessions es ON es.daily_application_id = a.id
       WHERE a.deleted_at IS NULL AND a.dept_id = ANY($1::uuid[])
         AND a.reg_date BETWEEN $2::date AND $3::date
       GROUP BY a.dept_id`,
      [deptIds, historicalFromStr, historicalToStr],
    ),
    pool.query(
      `SELECT a.dept_id, btrim(a.referral_channel) AS source,
              count(DISTINCT a.id)::int AS applications,
              count(DISTINCT a.id) FILTER (WHERE es.starting_date IS NOT NULL AND es.starting_date <= $3::date)::int AS started
       FROM daily_applications a
       LEFT JOIN employment_sessions es ON es.daily_application_id = a.id
       WHERE a.deleted_at IS NULL AND a.dept_id = ANY($1::uuid[])
         AND a.reg_date BETWEEN $2::date AND $3::date
         AND a.referral_channel IS NOT NULL AND btrim(a.referral_channel) <> ''
       GROUP BY a.dept_id, btrim(a.referral_channel)
       HAVING count(DISTINCT a.id) >= 3
       ORDER BY started DESC, applications DESC
       LIMIT 500`,
      [deptIds, historicalFromStr, historicalToStr],
    ),
    pool.query(
      `SELECT a.dept_id,
              count(DISTINCT a.id)::int AS applications,
              count(DISTINCT a.id) FILTER (WHERE es.id IS NULL)::int AS applications_without_session
       FROM daily_applications a
       LEFT JOIN employment_sessions es ON es.daily_application_id = a.id
       WHERE a.deleted_at IS NULL AND a.dept_id = ANY($1::uuid[])
       GROUP BY a.dept_id`,
      [deptIds],
    ),
    pool.query(
      `SELECT es.dept_id,
              count(*) FILTER (WHERE wp.id IS NULL)::int AS sessions_without_worker,
              count(*) FILTER (WHERE wp.deleted_at IS NOT NULL)::int AS sessions_with_deleted_worker,
              count(*) FILTER (WHERE es.daily_application_id IS NULL OR a.id IS NULL)::int AS sessions_without_application
       FROM employment_sessions es
       LEFT JOIN worker_profiles wp ON wp.id = es.worker_id
       LEFT JOIN daily_applications a ON a.id = es.daily_application_id
       WHERE es.dept_id = ANY($1::uuid[])
       GROUP BY es.dept_id`,
      [deptIds],
    ),
    scope === null
      ? pool.query(
          `SELECT
             (SELECT count(*)::int FROM worker_profiles wp WHERE wp.deleted_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM employment_sessions es WHERE es.worker_id = wp.id)) AS workers_without_session,
             (SELECT count(*)::int FROM daily_applications a WHERE a.deleted_at IS NULL AND a.dept_id IS NULL) AS missing_application_department,
             (SELECT count(*)::int FROM employment_sessions es WHERE es.dept_id IS NULL) AS missing_session_department,
             (SELECT count(*)::int FROM (
                SELECT cccd FROM worker_profiles WHERE deleted_at IS NULL GROUP BY cccd HAVING count(*) > 1
              ) duplicate_profiles) AS duplicate_active_worker_profiles`,
        )
      : Promise.resolve({ rows: [{ workers_without_session: null, missing_application_department: null, missing_session_department: null, duplicate_active_worker_profiles: 0 }] }),
  ]);

  const planningRows = planningRowsRaw as PlanningRow[];
  const planningByDept = new Map<string, PlanningRow[]>();
  const demandRecordsByDept = new Map<string, DemandRecord[]>();
  for (const row of planningRows) {
    const rows = planningByDept.get(row.departmentId) ?? [];
    rows.push(row);
    planningByDept.set(row.departmentId, rows);
    const records = demandRecordsByDept.get(row.departmentId) ?? [];
    records.push({
      id: row.id,
      departmentId: row.departmentId,
      startDate: row.startDate,
      endDate: row.endDate,
      value: demandValue(row),
      source: "PLANNING",
      status: row.status,
      supersededBy: row.supersededBy,
      lastUpdatedAt: iso(row.updatedAt),
    });
    demandRecordsByDept.set(row.departmentId, records);
  }

  const currentMap = new Map<string, number>();
  for (const row of currentRes.rows as UnknownRow[]) currentMap.set(String(row.dept_id), n(row.current_active));

  const eventsByDept = new Map<string, SupplyEvent[]>();
  const pushEvent = (departmentId: unknown, event: Omit<SupplyEvent, "departmentId">) => {
    if (!departmentId || !deptIds.includes(String(departmentId))) return;
    const id = String(departmentId);
    const rows = eventsByDept.get(id) ?? [];
    rows.push({ departmentId: id, ...event });
    eventsByDept.set(id, rows);
  };
  for (const row of incomingRes.rows as UnknownRow[]) {
    pushEvent(row.dept_id, { effectiveDate: String(row.effective_date), type: "CONFIRMED_INCOMING", quantity: n(row.c) });
  }
  for (const row of movementRes.rows as UnknownRow[]) {
    const quantity = n(row.c);
    const effectiveDate = String(row.effective_date);
    if (row.movement_type === "resignation") {
      pushEvent(row.from_dept_id, { effectiveDate, type: "EXPECTED_EXIT", quantity });
    } else if (row.movement_type === "transfer") {
      // CONFIRM_ARRIVED currently moves the session immediately. For a future effective date,
      // reconstruct today's snapshot, then apply the transfer on its effective date.
      const from = row.from_dept_id ? String(row.from_dept_id) : null;
      const to = row.to_dept_id ? String(row.to_dept_id) : null;
      if (to && deptIds.includes(to)) currentMap.set(to, Math.max(0, (currentMap.get(to) ?? 0) - quantity));
      if (from && deptIds.includes(from)) currentMap.set(from, (currentMap.get(from) ?? 0) + quantity);
      pushEvent(from, { effectiveDate, type: "TRANSFER_OUT", quantity });
      pushEvent(to, { effectiveDate, type: "TRANSFER_IN", quantity });
    }
  }

  const returningMap = new Map<string, number>((returningRes.rows as UnknownRow[]).map((r) => [String(r.dept_id), n(r.c)]));
  const funnelMap = new Map<string, { applications: number; approved: number; started: number; lastUpdatedAt: string | null }>();
  for (const row of funnelRes.rows as UnknownRow[]) {
    funnelMap.set(String(row.dept_id), {
      applications: n(row.applications),
      approved: n(row.approved),
      started: n(row.started),
      lastUpdatedAt: iso(row.last_updated_at),
    });
  }
  const referralMap = new Map<string, { source: string; applications: number; started: number }[]>();
  for (const row of referralRes.rows as UnknownRow[]) {
    const id = String(row.dept_id);
    const rows = referralMap.get(id) ?? [];
    rows.push({ source: String(row.source), applications: n(row.applications), started: n(row.started) });
    referralMap.set(id, rows);
  }
  const applicationDiagnosticsMap = new Map<string, UnknownRow>((applicationDiagnosticsRes.rows as UnknownRow[]).map((row) => [String(row.dept_id), row]));
  const sessionDiagnosticsMap = new Map<string, UnknownRow>((sessionDiagnosticsRes.rows as UnknownRow[]).map((row) => [String(row.dept_id), row]));
  const globalDiagnostic = (globalDiagnosticsRes.rows[0] ?? {}) as UnknownRow;

  const departmentDrafts: DepartmentDraft[] = [];
  for (const dept of deptRows) {
    const funnel = funnelMap.get(dept.id) ?? { applications: 0, approved: 0, started: 0, lastUpdatedAt: null };
    const conversion = calculateConversion(funnel.applications, funnel.approved, funnel.started, { from: historicalFromStr, to: historicalToStr });
    const appDiagnostic = applicationDiagnosticsMap.get(dept.id) ?? {};
    const sessionDiagnostic = sessionDiagnosticsMap.get(dept.id) ?? {};
    const diagnostics = buildAnalyticsCompleteness({
      applications: n(appDiagnostic.applications),
      applicationsWithoutSession: n(appDiagnostic.applications_without_session),
      sessionsWithoutWorker: n(sessionDiagnostic.sessions_without_worker),
      sessionsWithDeletedWorker: n(sessionDiagnostic.sessions_with_deleted_worker),
      sessionsWithoutApplication: n(sessionDiagnostic.sessions_without_application),
      workersWithoutSession: null,
      missingApplicationDepartment: null,
      missingSessionDepartment: null,
      duplicateActiveWorkerProfiles: 0,
    });
    const confidence = calculateForecastConfidence({
      demandAvailable: (planningByDept.get(dept.id)?.length ?? 0) > 0,
      currentSupplyAvailable: true,
      confirmedDataRatio: Math.min(completenessConfirmedRatio(diagnostics), scenario?.targetDepartmentId === dept.id ? 0.75 : 1),
      historicalSampleSize: funnel.applications,
      volatility: null,
      horizonDays: daysBetween(filters.from, filters.to) + 1,
      missingCriticalSources: ["ATS", "HRIS", "ATTENDANCE"],
      staleSources: [],
    });
    confidence.warnings.push(...diagnostics.warnings);
    let forecast = buildForecast({
      from: filters.from,
      to: filters.to,
      currentActive: currentMap.get(dept.id) ?? 0,
      demandRecords: demandRecordsByDept.get(dept.id) ?? [],
      supplyEvents: eventsByDept.get(dept.id) ?? [],
      confidence,
    });
    const baselinePoint = valueAtCriticalDate(forecast.points);
    const baselineVelocity = calculateVelocity({
      applications: funnel.applications,
      approved: funnel.approved,
      started: funnel.started,
      observationDays: HISTORICAL_DAYS,
      shortage: baselinePoint.shortage,
    });
    if (scenario?.targetDepartmentId === dept.id) {
      const effectiveScenario = {
        ...scenario,
        returningWorkersActivated: Math.min(scenario.returningWorkersActivated ?? 0, returningMap.get(dept.id) ?? 0),
      };
      forecast = applyScenarioToForecast(forecast, effectiveScenario, baselineVelocity.startedPerDay);
    }
    const point = valueAtCriticalDate(forecast.points);
    const supply = buildSupply(point);
    const gap = calculateGap(point.demand, point.expectedSupply);
    const requiredApplications = calculateRequiredApplications(gap.shortage, conversion.applicationToStarted, 10, {
      sampleSize: conversion.sampleSize,
      confidenceLevel: forecast.confidence.level,
    });
    const velocity = calculateVelocity({
      applications: funnel.applications,
      approved: funnel.approved,
      started: funnel.started,
      observationDays: HISTORICAL_DAYS,
      shortage: gap.shortage,
    });
    const firstRiskDays = forecast.firstRiskDate ? daysBetween(today, forecast.firstRiskDate) : null;
    const returningPool = returningMap.get(dept.id) ?? 0;
    const risk = assessRisk({
      demand: gap.demand,
      expectedSupply: gap.expectedSupply,
      shortage: gap.shortage,
      coverageRate: gap.coverageRate,
      daysToRequired: firstRiskDays,
      startedVelocityPerDay: velocity.startedPerDay,
      expectedDaysToCloseGap: velocity.expectedDaysToCloseGap,
      expectedExits: point.expectedExit,
      returningPool,
      pipelineAvailable: false,
      pipelineExpectedStart: 0,
      conversionRate: conversion.applicationToStarted,
      confidenceLevel: forecast.confidence.level,
    });
    const referralPerformance = [...(referralMap.get(dept.id) ?? [])]
      .sort((a, b) => {
        if (b.started !== a.started) return b.started - a.started;
        return (b.started / Math.max(1, b.applications)) - (a.started / Math.max(1, a.applications));
      })
      .map((row) => ({
        ...row,
        applicationToStarted: row.applications > 0 ? Math.round((row.started / row.applications) * 10_000) / 10_000 : null,
      }));
    const bestReferral = referralPerformance[0]?.source ?? null;

    departmentDrafts.push({
      departmentId: dept.id,
      departmentName: dept.deptName,
      groupName: dept.groupName ?? "",
      location: dept.location ?? "",
      division: dept.division ?? "",
      asOfDate: point.date,
      demand: buildDemand(point, planningByDept.get(dept.id) ?? []),
      supply,
      gap,
      forecast,
      risk,
      conversion,
      requiredApplications,
      velocity,
      referralPerformance,
      returningWorkerOpportunity: returningPool,
      diagnostics,
      pipeline: { ...PIPELINE_UNAVAILABLE },
      recommendedActions: [],
      topReferralSource: bestReferral,
    });
  }

  for (const dept of departmentDrafts) {
    const targetDate = dept.forecast.firstRiskDate ?? dept.asOfDate;
    const availableInternalSurplus = departmentDrafts
      .filter((other) => other.departmentId !== dept.departmentId)
      .reduce((sum, other) => sum + (other.forecast.points.find((point) => point.date === targetDate)?.surplus ?? 0), 0);
    dept.recommendedActions = recommendActions({
      department: { id: dept.departmentId, name: dept.departmentName },
      shortage: dept.gap.shortage,
      coverageRate: dept.gap.coverageRate,
      firstRiskDate: dept.forecast.firstRiskDate,
      daysToRequired: dept.forecast.firstRiskDate ? daysBetween(today, dept.forecast.firstRiskDate) : null,
      returningPool: dept.returningWorkerOpportunity,
      expectedExits: dept.supply.expectedExits,
      availableInternalSurplus,
      requiredAdditionalApplications: dept.requiredApplications.requiredAdditionalApplications,
      topReferralSource: dept.topReferralSource,
      conversionRate: dept.conversion.applicationToStarted,
      risk: dept.risk,
    });
  }

  const applications = departmentDrafts.reduce((sum, d) => sum + d.conversion.applications, 0);
  const approved = departmentDrafts.reduce((sum, d) => sum + d.conversion.approved, 0);
  const started = departmentDrafts.reduce((sum, d) => sum + d.conversion.started, 0);
  const globalConversion = calculateConversion(applications, approved, started, { from: historicalFromStr, to: historicalToStr });
  const overviewDiagnostics = buildAnalyticsCompleteness({
    applications: departmentDrafts.reduce((sum, department) => sum + department.diagnostics.applications, 0),
    applicationsWithoutSession: departmentDrafts.reduce((sum, department) => sum + department.diagnostics.applicationsWithoutSession, 0),
    sessionsWithoutWorker: departmentDrafts.reduce((sum, department) => sum + department.diagnostics.sessionsWithoutWorker, 0),
    sessionsWithDeletedWorker: departmentDrafts.reduce((sum, department) => sum + department.diagnostics.sessionsWithDeletedWorker, 0),
    sessionsWithoutApplication: departmentDrafts.reduce((sum, department) => sum + department.diagnostics.sessionsWithoutApplication, 0),
    workersWithoutSession: scope === null ? n(globalDiagnostic.workers_without_session) : null,
    missingApplicationDepartment: scope === null ? n(globalDiagnostic.missing_application_department) : null,
    missingSessionDepartment: scope === null ? n(globalDiagnostic.missing_session_department) : null,
    duplicateActiveWorkerProfiles: n(globalDiagnostic.duplicate_active_worker_profiles),
  });
  const calculatedGlobalConfidence = calculateForecastConfidence({
    demandAvailable: planningRows.length > 0,
    currentSupplyAvailable: true,
    confirmedDataRatio: Math.min(completenessConfirmedRatio(overviewDiagnostics), scenario ? 0.75 : 1),
    historicalSampleSize: applications,
    volatility: null,
    horizonDays: daysBetween(filters.from, filters.to) + 1,
    missingCriticalSources: ["ATS", "HRIS", "ATTENDANCE"],
    staleSources: [],
  });
  calculatedGlobalConfidence.warnings.push(...overviewDiagnostics.warnings);
  const globalConfidence = scenario
    ? {
        score: Math.min(calculatedGlobalConfidence.score, 49),
        level: "LOW" as const,
        explanation: "Kịch bản what-if là ESTIMATED và không phải cam kết nhân lực.",
        warnings: [...calculatedGlobalConfidence.warnings, "Kết quả scenario được phân loại ESTIMATED."],
      }
    : calculatedGlobalConfidence;
  const globalForecast = aggregateForecasts(departmentDrafts.map((d) => d.forecast), globalConfidence);
  const globalPoint = valueAtCriticalDate(globalForecast.points);
  const globalGap = calculateGap(globalPoint.demand, globalPoint.expectedSupply);
  const globalVelocity = calculateVelocity({
    applications,
    approved,
    started,
    observationDays: HISTORICAL_DAYS,
    shortage: globalGap.shortage,
  });
  const returningWorkerOpportunity = departmentDrafts.reduce((sum, d) => sum + d.returningWorkerOpportunity, 0);
  const referralTotals = new Map<string, { source: string; applications: number; started: number }>();
  for (const department of departmentDrafts) {
    for (const source of department.referralPerformance) {
      const total = referralTotals.get(source.source) ?? { source: source.source, applications: 0, started: 0 };
      total.applications += source.applications;
      total.started += source.started;
      referralTotals.set(source.source, total);
    }
  }
  const globalReferralPerformance = [...referralTotals.values()]
    .map((row) => ({
      ...row,
      applicationToStarted: row.applications > 0 ? Math.round((row.started / row.applications) * 10_000) / 10_000 : null,
    }))
    .sort((a, b) => b.started - a.started || (b.applicationToStarted ?? 0) - (a.applicationToStarted ?? 0))
    .slice(0, 10);
  const globalRisk = assessRisk({
    demand: globalGap.demand,
    expectedSupply: globalGap.expectedSupply,
    shortage: globalGap.shortage,
    coverageRate: globalGap.coverageRate,
    daysToRequired: globalForecast.firstRiskDate ? daysBetween(today, globalForecast.firstRiskDate) : null,
    startedVelocityPerDay: globalVelocity.startedPerDay,
    expectedDaysToCloseGap: globalVelocity.expectedDaysToCloseGap,
    expectedExits: globalPoint.expectedExit,
    returningPool: returningWorkerOpportunity,
    pipelineAvailable: false,
    pipelineExpectedStart: 0,
    conversionRate: globalConversion.applicationToStarted,
    confidenceLevel: globalConfidence.level,
  });

  const recommendations = departmentDrafts
    .flatMap((d) => d.recommendedActions)
    .sort((a, b) => actionRank(b) - actionRank(a))
    .filter((item, index, all) => all.findIndex((x) => x.actionKey === item.actionKey && x.affectedDepartment?.id === item.affectedDepartment?.id) === index)
    .slice(0, 12);

  const cleanDepartments: DepartmentIntelligence[] = departmentDrafts
    .map(({ topReferralSource: _topReferralSource, ...department }) => department)
    .sort((a, b) => b.risk.score - a.risk.score || b.gap.shortage - a.gap.shortage);
  void movementRes;

  return {
    generatedAt,
    period: { from: filters.from, to: filters.to, label: `Next ${daysBetween(filters.from, filters.to) + 1} days` },
    scope: {
      restricted: scope !== null,
      departmentCount: deptRows.length,
      note: scope !== null ? "Trong phạm vi dữ liệu bạn có quyền xem." : "Phạm vi toàn bộ dữ liệu được cấp quyền.",
    },
    outOfScope: false,
    asOfDate: globalPoint.date,
    demand: buildDemand(globalPoint, planningRows),
    supply: buildSupply(globalPoint),
    gap: globalGap,
    forecast: globalForecast,
    risk: globalRisk,
    conversion: globalConversion,
    requiredApplications: calculateRequiredApplications(globalGap.shortage, globalConversion.applicationToStarted, 10, {
      sampleSize: globalConversion.sampleSize,
      confidenceLevel: globalConfidence.level,
    }),
    velocity: globalVelocity,
    referralPerformance: globalReferralPerformance,
    returningWorkerOpportunity,
    expectedExits: globalPoint.expectedExit,
    diagnostics: overviewDiagnostics,
    pipeline: { ...PIPELINE_UNAVAILABLE },
    departments: cleanDepartments,
    recommendedActions: recommendations,
    sources: sourceStatuses(generatedAt),
    dataFreshnessWarnings: [
      "ATS chưa tích hợp: pipeline supply = UNAVAILABLE, không phải bằng 0.",
      "Attendance chưa tích hợp: recordedCurrentWorkforce dựa trên Employment Session gần nhất, không phải số người hiện diện thời gian thực.",
      ...overviewDiagnostics.warnings,
    ],
    scenario: { applied: Boolean(scenario), mode: scenario ? "SIMULATION" : null, overrides: scenario, classification: scenario ? "ESTIMATED" : null },
  };
}
