import "server-only";
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions, recruitmentRequests, workerProfiles, workforceMovements } from "@/db/schema";
import { getUserScope } from "@/lib/auth";
import { bucketLabel, bucketStart, enumerateBuckets, pctChange, trendGranularity, type Granularity } from "@/lib/analytics-core";
import { canAggregateTransferIn, canAggregateTransferOut } from "@/lib/data-scope";
import { isFemale, isMale, todayStr } from "@/lib/helpers";
import { listWorkforceRequests } from "@/lib/workforce-request";
import { classifyDepartmentRisk, type RiskSignals } from "../risk-rules.ts";
import { resolveTimeExpression, type TimeExpressionInput, type ResolvedPeriod } from "../time-resolver.ts";
import { capLimit, intersectDepartmentFilter } from "../scope-helpers.ts";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";

/**
 * Phase 2 "AI Analyst" — deterministic, server-computed analytics. DeepSeek
 * explains; it NEVER computes gap/YoY/trend numbers itself — every number in
 * these tool results is produced here. Every canonical business formula
 * already established elsewhere is reused (never reimplemented):
 *   - Realtime Workforce Request gap: workforce-request.ts's
 *     listWorkforceRequests -> computeRequestKpi (workforce-request-kpi.ts).
 *   - Stored Recruitment Balance: recruitmentRequests.totalBalance (snapshot
 *     formula, see recruitment-kpi.ts).
 *   - Movement in/out aggregation eligibility: data-scope.ts's
 *     canAggregateTransferOut/In (directional, same rule as the movements API).
 *   - Trend bucketing: analytics-core.ts's trendGranularity/enumerateBuckets/
 *     bucketStart/bucketLabel/pctChange (already used by the Analytics
 *     Dashboard — reused verbatim here, not duplicated).
 *
 * Historical/point-in-time headcount reconstruction (no existing function —
 * confirmed gap in the Phase 1 domain audit) reuses the EXACT windowing
 * shape workforce-request.ts's fetchHistoricalAllocationRows already
 * establishes for request-scoped history: startingDate <= asOf AND
 * (endDate IS NULL OR endDate >= asOf). KNOWN LIMITATION (documented, not
 * silently assumed away): `status` itself has no history table, so a
 * session whose status changed after `asOf` cannot be perfectly
 * reconstructed — same limitation the existing request-scoped history has.
 */

const MAX_LOOKBACK_DAYS = 3660; // ~10 years, matches time-resolver's own cap
const MAX_TREND_BUCKETS = 60;
const MAX_RANKING_ROWS = 15;

function resolvePeriodOrThrow(input: TimeExpressionInput): { period: ResolvedPeriod; comparisonPeriod: ResolvedPeriod | null } {
  const resolved = resolveTimeExpression(input, todayStr());
  if (!resolved.ok) throw new ToolExecutionError("INVALID_ARGS", resolved.error);
  return resolved;
}

const PERIOD_ARG_SCHEMA = {
  period: { type: "string", description: "Từ khoá kỳ chuẩn: today, yesterday, this_week, last_week, this_month, last_month, this_quarter, last_quarter, this_year, last_year, last_7_days, last_30_days, last_90_days. Bỏ trống = tháng này." },
  year: { type: "number", description: "Năm cụ thể, ví dụ 2025 — dùng cho câu hỏi 'năm 2025'. Ưu tiên hơn period." },
  from: { type: "string", description: "Ngày bắt đầu YYYY-MM-DD (dùng cùng với to cho khoảng tuỳ ý). Ưu tiên cao nhất." },
  to: { type: "string", description: "Ngày kết thúc YYYY-MM-DD." },
  departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." },
} as const;

/* ============================================================
   INTERNAL HELPERS (DB-touching, not tools themselves)
   ============================================================ */

async function getHeadcountAsOf(departmentIds: string[] | null, asOf: string): Promise<{ male: number; female: number; total: number }> {
  const conditions = [
    eq(employmentSessions.status, "APPROVED"),
    lte(employmentSessions.startingDate, asOf),
    or(isNull(employmentSessions.endDate), gte(employmentSessions.endDate, asOf))!,
    isNull(workerProfiles.deletedAt),
  ];
  if (departmentIds !== null) conditions.push(inArray(employmentSessions.deptId, departmentIds));
  const rows = await db
    .select({ gender: workerProfiles.gender })
    .from(employmentSessions)
    .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .where(and(...conditions));
  let male = 0;
  let female = 0;
  for (const r of rows) {
    if (isMale(r.gender)) male += 1;
    else if (isFemale(r.gender)) female += 1;
  }
  return { male, female, total: rows.length };
}

async function getDemandForPeriod(departmentIds: string[] | null, from: string, to: string): Promise<{ male: number; female: number; total: number; requestCount: number }> {
  const conditions = [isNull(recruitmentRequests.deletedAt), gte(recruitmentRequests.expectedDate, from), lte(recruitmentRequests.expectedDate, to)];
  if (departmentIds !== null) {
    if (departmentIds.length === 0) return { male: 0, female: 0, total: 0, requestCount: 0 };
    conditions.push(inArray(recruitmentRequests.departmentId, departmentIds));
  }
  const rows = await db
    .select({
      maleRq: sql<number>`COALESCE(SUM(${recruitmentRequests.maleRq}), 0)`,
      femaleRq: sql<number>`COALESCE(SUM(${recruitmentRequests.femaleRq}), 0)`,
      total: sql<number>`COALESCE(SUM(${recruitmentRequests.totalRequest}), 0)`,
      requestCount: sql<number>`count(*)`,
    })
    .from(recruitmentRequests)
    .where(and(...conditions));
  const r = rows[0] ?? { maleRq: 0, femaleRq: 0, total: 0, requestCount: 0 };
  return { male: r.maleRq, female: r.femaleRq, total: r.total, requestCount: r.requestCount };
}

/* ============================================================
   TOOLS
   ============================================================ */

type CompareArgs = TimeExpressionInput & { departmentId?: string };
type CompareResult = {
  currentPeriod: ResolvedPeriod;
  comparisonPeriod: ResolvedPeriod;
  current: { male: number; female: number; total: number };
  comparison: { male: number; female: number; total: number };
  absoluteDifference: number;
  percentDifference: number | null;
};

function periodArgsParse(raw: unknown): CompareArgs {
  const body = (raw ?? {}) as Record<string, unknown>;
  return {
    period: typeof body.period === "string" ? body.period : undefined,
    year: typeof body.year === "number" ? body.year : undefined,
    from: typeof body.from === "string" ? body.from : undefined,
    to: typeof body.to === "string" ? body.to : undefined,
    departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined,
  };
}

const compare_workforce_periods: ToolDefinition<CompareArgs, CompareResult> = {
  name: "compare_workforce_periods",
  description: "So sánh số lao động ACTIVE cuối kỳ hiện tại với 'cùng kỳ năm trước' (hoặc kỳ trước liền kề nếu không có dữ liệu năm trước). Trả về số tuyệt đối, chênh lệch và % thay đổi — đã tính sẵn, không tự ước lượng.",
  parameters: { type: "object", properties: PERIOD_ARG_SCHEMA, additionalProperties: false },
  parseArgs: periodArgsParse,
  execute: async (ctx: ToolContext, args): Promise<ToolResult<CompareResult>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const { period } = resolvePeriodOrThrow({ ...args, compareToSamePeriodLastYear: true });
    const comparison = resolveTimeExpression({ ...args, compareToSamePeriodLastYear: true }, todayStr());
    if (!comparison.ok || !comparison.comparisonPeriod) throw new ToolExecutionError("INTERNAL", "Không thể tính kỳ so sánh.");
    const [current, prior] = await Promise.all([
      getHeadcountAsOf(filter.departmentIds, period.to),
      getHeadcountAsOf(filter.departmentIds, comparison.comparisonPeriod.to),
    ]);
    return {
      data: {
        currentPeriod: period,
        comparisonPeriod: comparison.comparisonPeriod,
        current,
        comparison: prior,
        absoluteDifference: current.total - prior.total,
        percentDifference: pctChange(current.total, prior.total),
      },
      source: { domains: ["workforce"], asOf: period.to },
    };
  },
};

const compare_demand_periods: ToolDefinition<CompareArgs, CompareResult & { current: { male: number; female: number; total: number; requestCount: number }; comparison: { male: number; female: number; total: number; requestCount: number } }> = {
  name: "compare_demand_periods",
  description: "So sánh tổng nhu cầu tuyển dụng (theo Ngày cần nhân lực) của kỳ hiện tại với cùng kỳ năm trước. Trả về tổng Nam/Nữ, số Yêu cầu tuyển dụng, chênh lệch và % thay đổi.",
  parameters: { type: "object", properties: PERIOD_ARG_SCHEMA, additionalProperties: false },
  parseArgs: periodArgsParse,
  execute: async (ctx, args) => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const { period } = resolvePeriodOrThrow({ ...args, compareToSamePeriodLastYear: true });
    const comparison = resolveTimeExpression({ ...args, compareToSamePeriodLastYear: true }, todayStr());
    if (!comparison.ok || !comparison.comparisonPeriod) throw new ToolExecutionError("INTERNAL", "Không thể tính kỳ so sánh.");
    const [current, prior] = await Promise.all([
      getDemandForPeriod(filter.departmentIds, period.from, period.to),
      getDemandForPeriod(filter.departmentIds, comparison.comparisonPeriod.from, comparison.comparisonPeriod.to),
    ]);
    return {
      data: {
        currentPeriod: period,
        comparisonPeriod: comparison.comparisonPeriod,
        current,
        comparison: prior,
        absoluteDifference: current.total - prior.total,
        percentDifference: pctChange(current.total, prior.total),
      },
      source: { domains: ["recruitment", "planning"], asOf: period.to },
    };
  },
};

type CompareYearsArgs = { yearA: number; yearB: number; departmentId?: string };

const compare_demand_years: ToolDefinition<CompareYearsArgs, unknown> = {
  name: "compare_demand_years",
  description: "So sánh tổng nhu cầu tuyển dụng giữa hai năm cụ thể (ví dụ 2026 so với 2025). yearA là năm đang xét, yearB là năm so sánh.",
  parameters: {
    type: "object",
    properties: {
      yearA: { type: "number", description: "Năm đang xét, ví dụ 2026." },
      yearB: { type: "number", description: "Năm dùng để so sánh, ví dụ 2025." },
      departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." },
    },
    required: ["yearA", "yearB"],
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body.yearA !== "number" || typeof body.yearB !== "number") throw new ToolExecutionError("INVALID_ARGS", "yearA và yearB là bắt buộc.");
    return { yearA: body.yearA, yearB: body.yearB, departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined };
  },
  execute: async (ctx, args) => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const periodA = resolvePeriodOrThrow({ year: args.yearA });
    const periodB = resolvePeriodOrThrow({ year: args.yearB });
    const [a, b] = await Promise.all([
      getDemandForPeriod(filter.departmentIds, periodA.period.from, periodA.period.to),
      getDemandForPeriod(filter.departmentIds, periodB.period.from, periodB.period.to),
    ]);
    return {
      data: {
        yearA: { ...periodA.period, ...a },
        yearB: { ...periodB.period, ...b },
        absoluteDifference: a.total - b.total,
        percentDifference: pctChange(a.total, b.total),
      },
      source: { domains: ["recruitment", "planning"], asOf: todayStr() },
    };
  },
};

type RankingArgs = { asOf?: string; limit?: number };
type RankingRow = { departmentId: string; departmentName: string | null; requested: number; current: number; gap: number };

const get_workforce_gap_rankings: ToolDefinition<RankingArgs, { rankings: RankingRow[]; asOfDate: string }> = {
  name: "get_workforce_gap_rankings",
  description: "Xếp hạng các bộ phận theo khoảng trống nhân lực (Realtime Gap = Nhu cầu Workforce Request − Nhân lực hiện có), từ thiếu nhiều nhất đến ít nhất. Dùng cho câu hỏi 'bộ phận nào thiếu người nhiều nhất'.",
  parameters: {
    type: "object",
    properties: {
      asOf: { type: "string", description: "Ngày YYYY-MM-DD (mặc định hôm nay)." },
      limit: { type: "number", description: "Số bộ phận top cần xem (mặc định 10, tối đa 15)." },
    },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return {
      asOf: typeof body.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf) ? body.asOf : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    };
  },
  execute: async (ctx, args) => {
    const scope = await getUserScope(ctx.session);
    const asOfDate = args.asOf ?? todayStr();
    const rows = await listWorkforceRequests({ scope, asOf: asOfDate, limit: 500 });
    const byDept = new Map<string, RankingRow>();
    for (const r of rows) {
      const key = r.departmentId ?? "__none__";
      const existing = byDept.get(key) ?? { departmentId: key, departmentName: r.deptName ?? r.department, requested: 0, current: 0, gap: 0 };
      existing.requested += r.kpi.totalRequest;
      existing.current += r.kpi.totalCurrent;
      existing.gap += r.kpi.totalBalance;
      byDept.set(key, existing);
    }
    const limit = capLimit(args.limit, MAX_RANKING_ROWS, 10);
    const rankings = [...byDept.values()].sort((a, b) => b.gap - a.gap).slice(0, limit);
    return { data: { rankings, asOfDate }, source: { domains: ["workforce_request"], asOf: asOfDate } };
  },
};

/**
 * C2 (Mission C — Product Consolidation): previously read the STALE persisted
 * recruitmentRequests.totalBalance column directly via raw SQL SUM/filter —
 * the exact source-of-truth violation Mission C's audit flagged (never the
 * distinct, deliberately-kept-separate "Recruitment Balance vs Realtime Gap"
 * snapshot metric in recruitment-kpi.ts, which this tool's old description
 * text misleadingly referenced but did not actually call). Now reuses
 * listWorkforceRequests()'s canonical, allocation-aware `.kpi.totalBalance`
 * — the SAME engine/aggregation pattern as the sibling get_workforce_gap_rankings
 * tool just above, bounded by the same MAX_KPI_CANDIDATES-equivalent limit.
 */
const get_recruitment_gap_rankings: ToolDefinition<RankingArgs, { rankings: RankingRow[]; asOfDate: string }> = {
  name: "get_recruitment_gap_rankings",
  description: "Xếp hạng các bộ phận theo khoảng trống Yêu cầu tuyển dụng (canonical Balance = max(0, Target − Current), allocation-aware), từ thiếu nhiều nhất đến ít nhất.",
  parameters: {
    type: "object",
    properties: { limit: { type: "number", description: "Số bộ phận top cần xem (mặc định 10, tối đa 15)." } },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return { limit: typeof body.limit === "number" ? body.limit : undefined };
  },
  execute: async (ctx, args) => {
    const scope = await getUserScope(ctx.session);
    const asOfDate = todayStr();
    if (scope !== null && scope.length === 0) return { data: { rankings: [], asOfDate }, source: { domains: ["recruitment"], asOf: asOfDate } };
    const rows = await listWorkforceRequests({ scope, asOf: asOfDate, limit: 2000 });
    const byDept = new Map<string, RankingRow>();
    for (const r of rows) {
      const key = r.departmentId ?? "__none__";
      const existing = byDept.get(key) ?? { departmentId: key, departmentName: r.deptName ?? r.department, requested: 0, current: 0, gap: 0 };
      existing.requested += r.kpi.totalRequest;
      existing.current += r.kpi.totalCurrent;
      existing.gap += r.kpi.totalBalance;
      byDept.set(key, existing);
    }
    const limit = capLimit(args.limit, MAX_RANKING_ROWS, 10);
    const rankings = [...byDept.values()].sort((a, b) => b.gap - a.gap).slice(0, limit);
    return { data: { rankings, asOfDate }, source: { domains: ["recruitment"], asOf: asOfDate } };
  },
};

type TrendArgs = TimeExpressionInput & { departmentId?: string };
type TrendPoint = { bucket: string; label: string; total: number };

const get_workforce_trend: ToolDefinition<TrendArgs, { granularity: Granularity; points: TrendPoint[]; period: ResolvedPeriod }> = {
  name: "get_workforce_trend",
  description: "Lấy chuỗi biến động số lao động ACTIVE theo thời gian (điểm cuối mỗi bucket ngày/tuần/tháng, tuỳ độ dài khoảng) trong một kỳ. Dùng cho câu hỏi 'nguồn lực thay đổi thế nào trong N ngày qua'.",
  parameters: { type: "object", properties: PERIOD_ARG_SCHEMA, additionalProperties: false },
  parseArgs: periodArgsParse,
  execute: async (ctx, args) => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const { period } = resolvePeriodOrThrow(args);
    const days = Math.round((new Date(period.to + "T00:00:00Z").getTime() - new Date(period.from + "T00:00:00Z").getTime()) / 86_400_000) + 1;
    const g = trendGranularity(days);
    const buckets = enumerateBuckets(period.from, period.to, g).slice(0, MAX_TREND_BUCKETS);
    const points: TrendPoint[] = [];
    for (const bucket of buckets) {
      const asOf = bucket > period.to ? period.to : bucket;
      const headcount = await getHeadcountAsOf(filter.departmentIds, asOf);
      points.push({ bucket, label: bucketLabel(bucket, g), total: headcount.total });
    }
    return { data: { granularity: g, points, period }, source: { domains: ["workforce"], asOf: period.to } };
  },
};

const get_demand_trend: ToolDefinition<TrendArgs, { granularity: Granularity; points: TrendPoint[]; period: ResolvedPeriod }> = {
  name: "get_demand_trend",
  description: "Lấy chuỗi tổng nhu cầu tuyển dụng theo thời gian (tổng theo Ngày cần nhân lực trong mỗi bucket ngày/tuần/tháng) trong một kỳ.",
  parameters: { type: "object", properties: PERIOD_ARG_SCHEMA, additionalProperties: false },
  parseArgs: periodArgsParse,
  execute: async (ctx, args) => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const { period } = resolvePeriodOrThrow(args);
    const days = Math.round((new Date(period.to + "T00:00:00Z").getTime() - new Date(period.from + "T00:00:00Z").getTime()) / 86_400_000) + 1;
    const g = trendGranularity(days);
    const bucketStarts = enumerateBuckets(period.from, period.to, g).slice(0, MAX_TREND_BUCKETS);
    const points: TrendPoint[] = [];
    for (let i = 0; i < bucketStarts.length; i++) {
      const from = bucketStarts[i];
      const to = i + 1 < bucketStarts.length ? new Date(new Date(bucketStarts[i + 1] + "T00:00:00Z").getTime() - 86_400_000).toISOString().slice(0, 10) : period.to;
      const demand = await getDemandForPeriod(filter.departmentIds, from, to > period.to ? period.to : to);
      points.push({ bucket: from, label: bucketLabel(from, g), total: demand.total });
    }
    return { data: { granularity: g, points, period }, source: { domains: ["recruitment", "planning"], asOf: period.to } };
  },
};

type MovementSummaryArgs = TimeExpressionInput & { departmentId?: string };
type MovementSummaryResult = { period: ResolvedPeriod; inflow: number; outflow: number; byStatus: Record<string, number> };

const get_movement_summary: ToolDefinition<MovementSummaryArgs, MovementSummaryResult> = {
  name: "get_movement_summary",
  description: "Tổng hợp dòng chuyển vào/ra (Thuyên chuyển) và Nghỉ việc trong một kỳ, trong phạm vi Data Scope — dùng công thức tổng hợp có hướng giống trang Nghỉ việc/Thuyên chuyển.",
  parameters: { type: "object", properties: PERIOD_ARG_SCHEMA, additionalProperties: false },
  parseArgs: periodArgsParse,
  execute: async (ctx, args) => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const { period } = resolvePeriodOrThrow(args);
    const conditions = [gte(workforceMovements.effectiveDate, period.from), lte(workforceMovements.effectiveDate, period.to)];
    if (filter.departmentIds !== null) {
      if (filter.departmentIds.length === 0) return { data: { period, inflow: 0, outflow: 0, byStatus: {} }, source: { domains: ["workforce_movements"], asOf: period.to } };
      conditions.push(or(inArray(workforceMovements.fromDeptId, filter.departmentIds), inArray(workforceMovements.toDeptId, filter.departmentIds))!);
    }
    const rows = await db
      .select({ movementType: workforceMovements.movementType, status: workforceMovements.status, fromDeptId: workforceMovements.fromDeptId, toDeptId: workforceMovements.toDeptId })
      .from(workforceMovements)
      .where(and(...conditions))
      .limit(2000);
    let inflow = 0;
    let outflow = 0;
    const byStatus: Record<string, number> = {};
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (r.movementType === "TRANSFER") {
        if (canAggregateTransferOut(scope, r.fromDeptId)) outflow += 1;
        if (canAggregateTransferIn(scope, r.toDeptId)) inflow += 1;
      }
    }
    return { data: { period, inflow, outflow, byStatus }, source: { domains: ["workforce_movements"], asOf: period.to } };
  },
};

type HiringExitArgs = TimeExpressionInput & { departmentId?: string };
type HiringExitResult = { period: ResolvedPeriod; hires: { male: number; female: number; total: number }; exits: { male: number; female: number; total: number } };

const get_hiring_exit_summary: ToolDefinition<HiringExitArgs, HiringExitResult> = {
  name: "get_hiring_exit_summary",
  description: "Đếm số lao động BẮT ĐẦU làm việc (theo Ngày nhận việc) và số lao động KẾT THÚC làm việc (theo Ngày kết thúc) trong một kỳ, kèm phân theo giới tính.",
  parameters: { type: "object", properties: PERIOD_ARG_SCHEMA, additionalProperties: false },
  parseArgs: periodArgsParse,
  execute: async (ctx, args) => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const { period } = resolvePeriodOrThrow(args);
    if (filter.departmentIds !== null && filter.departmentIds.length === 0) {
      return { data: { period, hires: { male: 0, female: 0, total: 0 }, exits: { male: 0, female: 0, total: 0 } }, source: { domains: ["employment"], asOf: period.to } };
    }
    const baseConditions = filter.departmentIds !== null ? [inArray(employmentSessions.deptId, filter.departmentIds)] : [];
    const [hireRows, exitRows] = await Promise.all([
      db
        .select({ gender: workerProfiles.gender })
        .from(employmentSessions)
        .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
        .where(and(gte(employmentSessions.startingDate, period.from), lte(employmentSessions.startingDate, period.to), isNull(workerProfiles.deletedAt), ...baseConditions)),
      db
        .select({ gender: workerProfiles.gender })
        .from(employmentSessions)
        .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
        .where(and(gte(employmentSessions.endDate, period.from), lte(employmentSessions.endDate, period.to), isNull(workerProfiles.deletedAt), ...baseConditions)),
    ]);
    const tally = (rows: { gender: string | null }[]) => {
      let male = 0;
      let female = 0;
      for (const r of rows) {
        if (isMale(r.gender)) male += 1;
        else if (isFemale(r.gender)) female += 1;
      }
      return { male, female, total: rows.length };
    };
    return { data: { period, hires: tally(hireRows), exits: tally(exitRows) }, source: { domains: ["employment"], asOf: period.to } };
  },
};

type RiskArgs = { departmentId?: string; limit?: number };
type DeptRiskRow = { departmentId: string; departmentName: string | null; level: string; score: number; factors: string[] };

const get_department_risk_summary: ToolDefinition<RiskArgs, { departments: DeptRiskRow[]; asOfDate: string; lookbackDays: number; lookaheadDays: number }> = {
  name: "get_department_risk_summary",
  description: "Đánh giá nguy cơ thiếu người (LOW/MEDIUM/HIGH, có giải thích) theo bộ phận, dựa trên quy tắc xác định (khoảng trống hiện tại, nghỉ việc gần đây, thuyên chuyển đi gần đây, Yêu cầu tuyển dụng còn mở, nhu cầu sắp đến hạn). Nếu bỏ trống departmentId, trả về xếp hạng tất cả bộ phận trong phạm vi, HIGH trước.",
  parameters: {
    type: "object",
    properties: {
      departmentId: { type: "string", description: "UUID bộ phận cụ thể (tuỳ chọn) — bỏ trống để đánh giá toàn bộ phạm vi." },
      limit: { type: "number", description: "Số bộ phận tối đa khi không chỉ định departmentId (mặc định 10, tối đa 15)." },
    },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return {
      departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    };
  },
  execute: async (ctx, args) => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const asOfDate = todayStr();
    const lookbackDays = 30;
    const lookaheadDays = 14;
    const lookbackFrom = new Date(new Date(asOfDate + "T00:00:00Z").getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const lookaheadTo = new Date(new Date(asOfDate + "T00:00:00Z").getTime() + lookaheadDays * 86_400_000).toISOString().slice(0, 10);

    const requestRows = await listWorkforceRequests({ scope, departmentId: args.departmentId, asOf: asOfDate, limit: 500 });
    const byDept = new Map<string, { departmentName: string | null; requested: number; current: number; gap: number; upcomingDemandCount: number; openRecruitmentGapCount: number }>();
    for (const r of requestRows) {
      const key = r.departmentId ?? "__none__";
      const existing = byDept.get(key) ?? { departmentName: r.deptName ?? r.department, requested: 0, current: 0, gap: 0, upcomingDemandCount: 0, openRecruitmentGapCount: 0 };
      existing.requested += r.kpi.totalRequest;
      existing.current += r.kpi.totalCurrent;
      existing.gap += r.kpi.totalBalance;
      if (r.expectedDate && r.expectedDate >= asOfDate && r.expectedDate <= lookaheadTo && r.kpi.totalBalance > 0) existing.upcomingDemandCount += 1;
      // C2 (Mission C) — CANONICAL kpi.totalBalance, not the stale persisted
      // totalBalance column; requestRows already carries it (one shared
      // fetch, no extra query) so this replaces what used to be a separate
      // raw-SQL COUNT(*)-WHERE-totalBalance>0 query below.
      if ((r.status === "PENDING" || r.status === "PROCESSING") && r.kpi.totalBalance > 0) existing.openRecruitmentGapCount += 1;
      byDept.set(key, existing);
    }

    const deptIds = [...byDept.keys()].filter((k) => k !== "__none__");
    const [exitRows, movementRows] = await Promise.all([
      deptIds.length
        ? db.select({ deptId: employmentSessions.deptId, count: sql<number>`count(*)` }).from(employmentSessions).where(and(gte(employmentSessions.endDate, lookbackFrom), lte(employmentSessions.endDate, asOfDate), inArray(employmentSessions.deptId, deptIds))).groupBy(employmentSessions.deptId)
        : Promise.resolve([]),
      deptIds.length
        ? db.select({ deptId: workforceMovements.fromDeptId, count: sql<number>`count(*)` }).from(workforceMovements).where(and(eq(workforceMovements.movementType, "TRANSFER"), gte(workforceMovements.effectiveDate, lookbackFrom), lte(workforceMovements.effectiveDate, asOfDate), inArray(workforceMovements.fromDeptId, deptIds))).groupBy(workforceMovements.fromDeptId)
        : Promise.resolve([]),
    ]);
    const exitsByDept = new Map(exitRows.map((r) => [r.deptId, r.count]));
    const movementByDept = new Map(movementRows.map((r) => [r.deptId, r.count]));

    const results: DeptRiskRow[] = [...byDept.entries()].map(([deptId, agg]) => {
      const signals: RiskSignals = {
        currentGap: agg.gap,
        totalRequested: agg.requested,
        recentExits: exitsByDept.get(deptId) ?? 0,
        recentMovementOutflow: movementByDept.get(deptId) ?? 0,
        openRecruitmentGapCount: agg.openRecruitmentGapCount,
        upcomingDemandCount: agg.upcomingDemandCount,
      };
      const assessment = classifyDepartmentRisk(signals);
      return { departmentId: deptId, departmentName: agg.departmentName, level: assessment.level, score: assessment.score, factors: assessment.factors };
    });

    const levelOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    results.sort((a, b) => levelOrder[a.level] - levelOrder[b.level] || b.score - a.score);
    const limit = capLimit(args.limit, MAX_RANKING_ROWS, 10);
    return {
      data: { departments: args.departmentId ? results : results.slice(0, limit), asOfDate, lookbackDays, lookaheadDays },
      source: { domains: ["workforce_request", "employment", "workforce_movements", "recruitment"], asOf: asOfDate },
    };
  },
};

export const analyticsTools = [
  compare_workforce_periods,
  compare_demand_periods,
  compare_demand_years,
  get_workforce_gap_rankings,
  get_recruitment_gap_rankings,
  get_workforce_trend,
  get_demand_trend,
  get_movement_summary,
  get_hiring_exit_summary,
  get_department_risk_summary,
];
