import "server-only";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db, pool } from "@/db";
import { departments, planningPeriods } from "@/db/schema";
import { getUserScope, type Session } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { getWorkflowStages } from "@/lib/workflow";
import { batchComputePlanningMetrics } from "@/lib/planning";
import {
  addDays as addDaysStr,
  AGE_BUCKETS,
  APPROVED_STAGE_KEY,
  PENDING_STAGE_FALLBACK,
  UNKNOWN_REFERRAL_LABEL,
  buildApplicationWhere,
  bucketStart,
  enumerateBuckets,
  genderClassSql,
  makeKpi,
  matchDepartmentsByHierarchy,
  conversionPct,
  previousRange,
  rangeDays,
  resolveDeptRestriction,
  sessionCountBucketIndex,
  SESSION_DISTRIBUTION_LABELS,
  trendGranularity,
  type AnalyticsFilters,
  type DashboardAnalytics,
  type DeptMeta,
  type DeptPerformanceRow,
  type Granularity,
  type MovementDeptRow,
  type PlanningDeptRow,
  type ReferralSourceRow,
  type SupplyDemandPoint,
  type TrendBucket,
} from "@/lib/analytics-core";

/**
 * WORKFORCE ANALYTICS (Dashboard nâng cấp) — TOÀN BỘ aggregation nằm server-side, 1 lần gọi
 * trả đủ payload cho mọi widget (không để mỗi chart tự gọi 1 endpoint).
 *
 * Nguyên tắc đã audit:
 *   - Data Scope: mọi truy vấn đi qua resolveDeptRestriction(getUserScope, hierarchyFilter).
 *     scope=[] hoặc filter ngoài scope → mọi WHERE sinh điều kiện FALSE (không leak aggregate).
 *   - Planning: CHỈ đếm period ACTIVE + superseded_by IS NULL (không double-count version cũ —
 *     reviseActivePeriod() luôn set EXPIRED + supersededBy cho bản cũ, đây là lưới an toàn thứ 2)
 *     và số liệu demand/allocated/resigned/needed/fillRate lấy từ batchComputePlanningMetrics()
 *     (KHÔNG viết lại công thức).
 *   - Worker identity: Applications đếm daily_applications; Unique Workers đếm DISTINCT cccd;
 *     sessions đọc employment_sessions. NEW/RETURNING theo dw_match (server-side đối chiếu DW
 *     Data lúc đăng ký — không suy diễn từ label client).
 *   - Timezone: mọi mốc "hôm nay"/bucket ngày dùng Asia/Ho_Chi_Minh (todayStr + AT TIME ZONE).
 *   - SQL: chỉ trong file này, 100% parameterized (xem buildApplicationWhere) — không nối
 *     trực tiếp input người dùng.
 */

const GRAN_SQL: Record<Granularity, string> = { DAY: "day", WEEK: "week", MONTH: "month" };

type NumRow = Record<string, number | string | null>;

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function getScopedDepartments(): Promise<DeptMeta[]> {
  const rows = await db
    .select({
      id: departments.id,
      deptName: departments.deptName,
      groupName: departments.groupName,
      vnName: departments.vnName,
      location: departments.location,
      division: departments.division,
      section: departments.section,
    })
    .from(departments)
    .where(isNull(departments.deletedAt));
  return rows.map((r) => ({
    id: r.id,
    deptName: r.deptName,
    groupName: r.groupName ?? "",
    vnName: r.vnName,
    location: r.location ?? "",
    division: r.division ?? "",
    section: r.section ?? "",
  }));
}

/** Tổng hợp KPI + funnel cho 1 khoảng thời gian (dùng cho kỳ hiện tại VÀ kỳ so sánh). */
async function querySummary(
  f: AnalyticsFilters,
  range: { from: string; to: string },
  deptIds: string[] | null,
  startStageKeys: string[],
  today: string,
) {
  const { where, params } = buildApplicationWhere({ ...f, from: range.from, to: range.to }, deptIds);
  const pToday = params.length + 1;
  const pStart = params.length + 2;
  const { rows } = await pool.query(
    `SELECT
       count(*)::int AS applications,
       count(DISTINCT a.cccd)::int AS unique_workers,
       count(DISTINCT a.cccd) FILTER (WHERE a.dw_match = 'MATCHED')::int AS returning_workers,
       count(DISTINCT a.cccd) FILTER (WHERE a.dw_match <> 'MATCHED')::int AS new_workers,
       count(*) FILTER (WHERE a.status = '${APPROVED_STAGE_KEY}')::int AS approved,
       count(*) FILTER (WHERE a.status = '${APPROVED_STAGE_KEY}' AND a.starting_date IS NOT NULL AND a.starting_date <= $${pToday}::date)::int AS started,
       count(*) FILTER (WHERE NOT (a.status = ANY($${pStart}::text[])))::int AS processed
     FROM daily_applications a
     WHERE ${where}`,
    [...params, today, startStageKeys],
  );
  const r = rows[0] ?? {};
  return {
    applications: n(r.applications),
    uniqueWorkers: n(r.unique_workers),
    returningWorkers: n(r.returning_workers),
    newWorkers: n(r.new_workers),
    approved: n(r.approved),
    started: n(r.started),
    processed: n(r.processed),
  };
}

async function queryTrend(f: AnalyticsFilters, deptIds: string[] | null, g: Granularity, today: string): Promise<TrendBucket[]> {
  const { where, params } = buildApplicationWhere(f, deptIds);
  const pToday = params.length + 1;
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('${GRAN_SQL[g]}', a.reg_date), 'YYYY-MM-DD') AS bucket,
       count(*)::int AS applications,
       count(*) FILTER (WHERE a.status = '${APPROVED_STAGE_KEY}')::int AS approved,
       count(*) FILTER (WHERE a.status = '${APPROVED_STAGE_KEY}' AND a.starting_date IS NOT NULL AND a.starting_date <= $${pToday}::date)::int AS started,
       count(*) FILTER (WHERE a.dw_match <> 'MATCHED')::int AS new_count,
       count(*) FILTER (WHERE a.dw_match = 'MATCHED')::int AS returning_count
     FROM daily_applications a
     WHERE ${where}
     GROUP BY 1 ORDER BY 1`,
    [...params, today],
  );
  const byBucket = new Map<string, NumRow>(rows.map((r: NumRow) => [String(r.bucket), r]));
  return enumerateBuckets(f.from, f.to, g).map((date) => {
    const r = byBucket.get(date);
    return {
      date,
      applications: n(r?.applications),
      approved: n(r?.approved),
      started: n(r?.started),
      newCount: n(r?.new_count),
      returningCount: n(r?.returning_count),
    };
  });
}

async function queryReferral(f: AnalyticsFilters, deptIds: string[] | null, today: string): Promise<ReferralSourceRow[]> {
  const { where, params } = buildApplicationWhere(f, deptIds);
  const pToday = params.length + 1;
  const { rows } = await pool.query(
    `SELECT lower(btrim(coalesce(a.referral_channel, ''))) AS k,
       min(NULLIF(btrim(a.referral_channel), '')) AS display,
       count(*)::int AS applications,
       count(*) FILTER (WHERE a.status = '${APPROVED_STAGE_KEY}')::int AS approved,
       count(*) FILTER (WHERE a.status = '${APPROVED_STAGE_KEY}' AND a.starting_date IS NOT NULL AND a.starting_date <= $${pToday}::date)::int AS started
     FROM daily_applications a
     WHERE ${where}
     GROUP BY 1
     ORDER BY started DESC, applications DESC
     LIMIT 30`,
    [...params, today],
  );
  return rows.map((r: NumRow) => ({
    source: r.display ? String(r.display) : UNKNOWN_REFERRAL_LABEL,
    applications: n(r.applications),
    approved: n(r.approved),
    started: n(r.started),
    conversionPct: conversionPct(n(r.applications), n(r.started)),
  }));
}

async function queryDeptPerformance(
  f: AnalyticsFilters,
  deptIds: string[] | null,
  deptMap: Map<string, DeptMeta>,
  today: string,
  shortageByDept: Map<string, number>,
): Promise<DeptPerformanceRow[]> {
  const { where, params } = buildApplicationWhere(f, deptIds);
  const pToday = params.length + 1;
  const [perf, workforce] = await Promise.all([
    pool.query(
      `SELECT a.dept_id,
         count(*)::int AS registered,
         count(*) FILTER (WHERE a.status = '${APPROVED_STAGE_KEY}')::int AS approved,
         count(*) FILTER (WHERE a.status = '${APPROVED_STAGE_KEY}' AND a.starting_date IS NOT NULL AND a.starting_date <= $${pToday}::date)::int AS started
       FROM daily_applications a
       WHERE ${where} AND a.dept_id IS NOT NULL
       GROUP BY a.dept_id`,
      [...params, today],
    ),
    // "Đang làm việc" là STOCK (không phụ thuộc date range của filter) — chỉ áp Data Scope + hierarchy.
    deptIds !== null && deptIds.length === 0
      ? Promise.resolve({ rows: [] as NumRow[] })
      : pool.query(
          `SELECT es.dept_id, count(*)::int AS c
           FROM employment_sessions es
           WHERE es.status = '${APPROVED_STAGE_KEY}' AND es.end_date IS NULL
             ${deptIds !== null ? "AND es.dept_id = ANY($1::uuid[])" : ""}
           GROUP BY es.dept_id`,
          deptIds !== null ? [deptIds] : [],
        ),
  ]);

  const wfMap = new Map<string, number>(workforce.rows.map((r: NumRow) => [String(r.dept_id), n(r.c)]));
  const out: DeptPerformanceRow[] = [];
  const seen = new Set<string>();
  for (const r of perf.rows as NumRow[]) {
    const id = String(r.dept_id);
    const meta = deptMap.get(id);
    if (!meta) continue;
    seen.add(id);
    out.push({
      ...meta,
      registered: n(r.registered),
      approved: n(r.approved),
      started: n(r.started),
      currentWorkforce: wfMap.get(id) ?? 0,
      shortage: shortageByDept.get(id) ?? 0,
    });
  }
  // Bộ phận có shortage/workforce nhưng không có đơn trong kỳ vẫn hiện (metric selector cần).
  for (const [id, c] of wfMap) {
    if (seen.has(id)) continue;
    const meta = deptMap.get(id);
    if (!meta) continue;
    if (deptIds !== null && !deptIds.includes(id)) continue;
    seen.add(id);
    out.push({ ...meta, registered: 0, approved: 0, started: 0, currentWorkforce: c, shortage: shortageByDept.get(id) ?? 0 });
  }
  for (const [id, s] of shortageByDept) {
    if (seen.has(id) || s <= 0) continue;
    const meta = deptMap.get(id);
    if (!meta) continue;
    if (deptIds !== null && !deptIds.includes(id)) continue;
    out.push({ ...meta, registered: 0, approved: 0, started: 0, currentWorkforce: 0, shortage: s });
  }
  return out.sort((a, b) => b.started - a.started);
}

async function queryDemographics(f: AnalyticsFilters, deptIds: string[] | null) {
  const { where, params } = buildApplicationWhere(f, deptIds);
  const { rows } = await pool.query(
    `SELECT (${genderClassSql("a.gender")}) AS g,
       CASE
         WHEN a.age IS NULL OR a.age <= 0 OR a.age > 120 THEN 'Không rõ'
         WHEN a.age < 18 THEN '<18'
         WHEN a.age <= 24 THEN '18–24'
         WHEN a.age <= 34 THEN '25–34'
         WHEN a.age <= 44 THEN '35–44'
         WHEN a.age <= 54 THEN '45–54'
         ELSE '55+'
       END AS bucket,
       count(*)::int AS c
     FROM daily_applications a
     WHERE ${where}
     GROUP BY 1, 2`,
    params,
  );
  const gender = { male: 0, female: 0, other: 0 };
  const ageMap = new Map<string, number>();
  for (const r of rows as NumRow[]) {
    const c = n(r.c);
    if (r.g === "MALE") gender.male += c;
    else if (r.g === "FEMALE") gender.female += c;
    else gender.other += c;
    ageMap.set(String(r.bucket), (ageMap.get(String(r.bucket)) ?? 0) + c);
  }
  return {
    gender,
    age: AGE_BUCKETS.map((b) => ({ bucket: b as string, count: ageMap.get(b) ?? 0 })),
  };
}

/** Worker mix + returning distribution — dựa trên worker_profiles + employment_sessions. */
async function queryWorkerMix(f: AnalyticsFilters, deptIds: string[] | null) {
  const { where, params } = buildApplicationWhere(f, deptIds);

  const [sessionsRes, distRes, topDeptRes] = await Promise.all([
    // Số employment session gắn với các đơn trong kỳ (1 đơn = tối đa 1 session).
    pool.query(
      `SELECT count(*)::int AS c
       FROM employment_sessions es
       JOIN daily_applications a ON es.daily_application_id = a.id
       WHERE ${where}`,
      params,
    ),
    // Với mỗi NGƯỜI xuất hiện trong kỳ: tổng số đợt làm việc TRỌN ĐỜI + cờ returning (dw_match).
    pool.query(
      `WITH w AS (
         SELECT wp.id, bool_or(a.dw_match = 'MATCHED') AS is_returning
         FROM daily_applications a
         JOIN worker_profiles wp ON wp.cccd = a.cccd AND wp.deleted_at IS NULL
         WHERE ${where}
         GROUP BY wp.id
       ), s AS (
         SELECT w.id, w.is_returning, count(es.id)::int AS c
         FROM w LEFT JOIN employment_sessions es ON es.worker_id = w.id
         GROUP BY w.id, w.is_returning
       )
       SELECT c, is_returning, count(*)::int AS workers FROM s GROUP BY c, is_returning`,
      params,
    ),
    pool.query(
      `SELECT a.dept_id,
         count(DISTINCT a.cccd)::int AS workers,
         count(DISTINCT a.cccd) FILTER (WHERE a.dw_match = 'MATCHED')::int AS returning
       FROM daily_applications a
       WHERE ${where} AND a.dept_id IS NOT NULL
       GROUP BY a.dept_id
       HAVING count(DISTINCT a.cccd) >= 5
       ORDER BY (count(DISTINCT a.cccd) FILTER (WHERE a.dw_match = 'MATCHED'))::float / count(DISTINCT a.cccd) DESC
       LIMIT 5`,
      params,
    ),
  ]);

  const distribution = SESSION_DISTRIBUTION_LABELS.map((label) => ({ label: label as string, count: 0 }));
  let returningSessions = 0;
  let returningWorkerCount = 0;
  for (const r of distRes.rows as NumRow[]) {
    const workers = n(r.workers);
    const sessions = Math.max(1, n(r.c)); // worker chưa backfill session vẫn tính 1 đợt (chính đơn trong kỳ)
    distribution[sessionCountBucketIndex(sessions)].count += workers;
    if (Boolean(r.is_returning) === true) {
      returningSessions += sessions * workers;
      returningWorkerCount += workers;
    }
  }

  return {
    sessionsInPeriod: n(sessionsRes.rows[0]?.c),
    distribution,
    avgSessionsReturning: returningWorkerCount > 0 ? Math.round((returningSessions / returningWorkerCount) * 10) / 10 : null,
    topDeptRows: topDeptRes.rows as NumRow[],
  };
}

/**
 * Movements — PHÂN BIỆT RÕ:
 *   - requested  = yêu cầu ĐƯỢC TẠO trong kỳ (created_at theo giờ VN) — chưa chắc đã xảy ra.
 *   - effective  = đã có hiệu lực trong kỳ: resignation status='INACTIVE'; transfer
 *     status='TRANSFER_COMPLETED' (stageKey chuẩn của Workflow Engine, xem lib/workflow.ts).
 *     PENDING_HR KHÔNG được đếm là "đã nghỉ".
 * Data Scope cho transfer: Transfer OUT nhìn theo from_dept, Transfer IN nhìn theo to_dept —
 * user scoped chỉ thấy đầu thuộc scope của mình.
 */
async function queryMovements(f: AnalyticsFilters, deptIds: string[] | null, g: Granularity, deptMap: Map<string, DeptMeta>) {
  if (deptIds !== null && deptIds.length === 0) {
    return {
      pending: { resignations: 0, transfers: 0 },
      requested: { resignations: 0, transfers: 0 },
      effective: { resignations: 0, transfersIn: 0, transfersOut: 0 },
      trend: [],
      topDepartments: [] as MovementDeptRow[],
    };
  }

  const params: unknown[] = [f.from, f.to];
  let fromScope = "TRUE";
  let toScope = "TRUE";
  let anyScope = "TRUE";
  let pendingScope = "TRUE";
  if (deptIds !== null) {
    params.push(deptIds);
    fromScope = `m.from_dept_id = ANY($3::uuid[])`;
    toScope = `m.to_dept_id = ANY($3::uuid[])`;
    anyScope = `(${fromScope} OR ${toScope})`;
    pendingScope = `(m.from_dept_id = ANY($1::uuid[]) OR m.to_dept_id = ANY($1::uuid[]))`;
  }

  const [requestedRes, effectiveRes, pendingRes, trendRes, fromSideRes, toSideRes] = await Promise.all([
    pool.query(
      `SELECT m.movement_type, count(*)::int AS c
       FROM workforce_movements m
       WHERE (m.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1::date AND $2::date
         AND ${anyScope}
       GROUP BY 1`,
      params,
    ),
    pool.query(
      `SELECT
         count(*) FILTER (WHERE m.movement_type = 'resignation' AND m.status = 'INACTIVE' AND ${fromScope})::int AS resignations,
         count(*) FILTER (WHERE m.movement_type = 'transfer' AND m.status = 'TRANSFER_COMPLETED' AND ${fromScope})::int AS transfers_out,
         count(*) FILTER (WHERE m.movement_type = 'transfer' AND m.status = 'TRANSFER_COMPLETED' AND ${toScope})::int AS transfers_in
       FROM workforce_movements m
       WHERE m.effective_date BETWEEN $1::date AND $2::date`,
      params,
    ),
    pool.query(
      `SELECT m.movement_type, count(*)::int AS c
       FROM workforce_movements m
       WHERE m.status = 'PENDING_HR' AND ${pendingScope}
       GROUP BY 1`,
      deptIds !== null ? [deptIds] : [],
    ),
    pool.query(
      `SELECT to_char(date_trunc('${GRAN_SQL[g]}', m.effective_date), 'YYYY-MM-DD') AS bucket,
         count(*) FILTER (WHERE m.movement_type = 'resignation' AND m.status = 'INACTIVE' AND ${fromScope})::int AS resignations,
         count(*) FILTER (WHERE m.movement_type = 'transfer' AND m.status = 'TRANSFER_COMPLETED' AND ${anyScope})::int AS transfers
       FROM workforce_movements m
       WHERE m.effective_date BETWEEN $1::date AND $2::date
       GROUP BY 1 ORDER BY 1`,
      params,
    ),
    pool.query(
      `SELECT m.from_dept_id AS dept_id,
         count(*) FILTER (WHERE m.movement_type = 'resignation' AND m.status = 'INACTIVE')::int AS resignations,
         count(*) FILTER (WHERE m.movement_type = 'transfer' AND m.status = 'TRANSFER_COMPLETED')::int AS transfers_out
       FROM workforce_movements m
       WHERE m.effective_date BETWEEN $1::date AND $2::date AND m.from_dept_id IS NOT NULL AND ${fromScope}
       GROUP BY 1`,
      params,
    ),
    pool.query(
      `SELECT m.to_dept_id AS dept_id,
         count(*) FILTER (WHERE m.movement_type = 'transfer' AND m.status = 'TRANSFER_COMPLETED')::int AS transfers_in
       FROM workforce_movements m
       WHERE m.effective_date BETWEEN $1::date AND $2::date AND m.to_dept_id IS NOT NULL AND ${toScope}
       GROUP BY 1`,
      params,
    ),
  ]);

  const requested = { resignations: 0, transfers: 0 };
  for (const r of requestedRes.rows as NumRow[]) {
    if (r.movement_type === "resignation") requested.resignations = n(r.c);
    if (r.movement_type === "transfer") requested.transfers = n(r.c);
  }
  const pending = { resignations: 0, transfers: 0 };
  for (const r of pendingRes.rows as NumRow[]) {
    if (r.movement_type === "resignation") pending.resignations = n(r.c);
    if (r.movement_type === "transfer") pending.transfers = n(r.c);
  }
  const e = effectiveRes.rows[0] ?? {};

  const trendMap = new Map<string, NumRow>((trendRes.rows as NumRow[]).map((r) => [String(r.bucket), r]));
  const trend = enumerateBuckets(f.from, f.to, g).map((date) => ({
    date,
    resignations: n(trendMap.get(date)?.resignations),
    transfers: n(trendMap.get(date)?.transfers),
  }));

  const deptAgg = new Map<string, MovementDeptRow>();
  const ensure = (id: string): MovementDeptRow | null => {
    const meta = deptMap.get(id);
    if (!meta) return null;
    let row = deptAgg.get(id);
    if (!row) {
      row = { deptId: id, deptName: meta.deptName, groupName: meta.groupName, resignations: 0, transfersIn: 0, transfersOut: 0, total: 0 };
      deptAgg.set(id, row);
    }
    return row;
  };
  for (const r of fromSideRes.rows as NumRow[]) {
    const row = ensure(String(r.dept_id));
    if (!row) continue;
    row.resignations += n(r.resignations);
    row.transfersOut += n(r.transfers_out);
  }
  for (const r of toSideRes.rows as NumRow[]) {
    const row = ensure(String(r.dept_id));
    if (!row) continue;
    row.transfersIn += n(r.transfers_in);
  }
  const topDepartments = [...deptAgg.values()]
    .map((r) => ({ ...r, total: r.resignations + r.transfersIn + r.transfersOut }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return {
    pending,
    requested,
    effective: { resignations: n(e.resignations), transfersIn: n(e.transfers_in), transfersOut: n(e.transfers_out) },
    trend,
    topDepartments,
  };
}

/**
 * PLANNING — dùng planning engine hiện có. Chỉ period ACTIVE + superseded_by IS NULL,
 * overlap với kỳ đang lọc (start <= to AND end >= from).
 *
 * SUPPLY vs DEMAND TREND — công thức (được chọn để KHÔNG nhân demand theo ngày):
 *   - demand(t)    = tổng demandTotal của các kế hoạch ACTIVE có hiệu lực TẠI bucket t
 *                    (point-in-time snapshot, không cộng dồn từng ngày).
 *   - allocated(t) = số phân bổ (allocation của session APPROVED chưa kết thúc) đã tồn tại
 *                    TÍNH ĐẾN cuối bucket t (allocated_at theo giờ VN).
 *   - started(t)   = luỹ kế số người bắt đầu làm (starting_date <= cuối bucket t) trong kỳ.
 */
async function queryPlanning(
  f: AnalyticsFilters,
  deptIds: string[] | null,
  g: Granularity,
  deptMap: Map<string, DeptMeta>,
  today: string,
) {
  if (deptIds !== null && deptIds.length === 0) return { planning: null, shortageByDept: new Map<string, number>() };

  const conds = [
    eq(planningPeriods.status, "ACTIVE"),
    isNull(planningPeriods.supersededBy),
    lte(planningPeriods.startDate, f.to),
    gte(planningPeriods.endDate, f.from),
  ];
  if (deptIds !== null) conds.push(inArray(planningPeriods.departmentId, deptIds));

  const periods = await db
    .select({
      id: planningPeriods.id,
      departmentId: planningPeriods.departmentId,
      startDate: planningPeriods.startDate,
      endDate: planningPeriods.endDate,
    })
    .from(planningPeriods)
    .where(and(...conds));

  const shortageByDept = new Map<string, number>();
  if (periods.length === 0) return { planning: null, shortageByDept };

  const metricsMap = await batchComputePlanningMetrics(periods.map((p) => p.id));

  const totals = { demand: 0, allocated: 0, resigned: 0, recruitmentNeeded: 0 };
  const perDept = new Map<string, PlanningDeptRow>();
  const demandByPeriod = new Map<string, number>();
  for (const p of periods) {
    const m = metricsMap.get(p.id);
    if (!m) continue;
    demandByPeriod.set(p.id, m.demandTotal);
    totals.demand += m.demandTotal;
    totals.allocated += m.allocatedTotal;
    totals.resigned += m.resignedTotal;
    totals.recruitmentNeeded += m.recruitmentNeededTotal;
    const meta = deptMap.get(p.departmentId);
    let row = perDept.get(p.departmentId);
    if (!row) {
      row = {
        deptId: p.departmentId,
        deptName: meta?.deptName ?? "—",
        groupName: meta?.groupName ?? "",
        vnName: meta?.vnName ?? null,
        demand: 0,
        allocated: 0,
        gap: 0,
        fillRatePct: 0,
      };
      perDept.set(p.departmentId, row);
    }
    row.demand += m.demandTotal;
    row.allocated += m.allocatedTotal;
    row.gap += m.recruitmentNeededTotal;
  }
  for (const row of perDept.values()) {
    row.fillRatePct = row.demand > 0 ? Math.min(100, Math.round((row.allocated / row.demand) * 100)) : 0;
    shortageByDept.set(row.deptId, row.gap);
  }

  // Supply vs Demand trend
  const buckets = enumerateBuckets(f.from, f.to, g);
  const periodIds = periods.map((p) => p.id);
  const { where: appWhere, params: appParams } = buildApplicationWhere(f, deptIds);
  const [allocRes, startedRes] = await Promise.all([
    pool.query(
      `SELECT to_char((pa.allocated_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS d, count(*)::int AS c
       FROM planning_allocations pa
       JOIN employment_sessions es ON pa.employment_session_id = es.id
       WHERE pa.planning_period_id = ANY($1::uuid[])
         AND es.status = '${APPROVED_STAGE_KEY}' AND es.end_date IS NULL
       GROUP BY 1 ORDER BY 1`,
      [periodIds],
    ),
    pool.query(
      `SELECT to_char(a.starting_date, 'YYYY-MM-DD') AS d, count(*)::int AS c
       FROM daily_applications a
       WHERE ${appWhere} AND a.status = '${APPROVED_STAGE_KEY}' AND a.starting_date IS NOT NULL AND a.starting_date <= $${appParams.length + 1}::date
       GROUP BY 1 ORDER BY 1`,
      [...appParams, today],
    ),
  ]);

  const allocDates = (allocRes.rows as NumRow[]).map((r) => ({ d: String(r.d), c: n(r.c) }));
  const startDates = (startedRes.rows as NumRow[]).map((r) => ({ d: String(r.d), c: n(r.c) }));

  const rangeEndExclusive = addDaysStr(f.to, 1);
  const supplyDemand: SupplyDemandPoint[] = buckets.map((b, i) => {
    const bucketEnd = i + 1 < buckets.length ? buckets[i + 1] : rangeEndExclusive;
    // demand: kế hoạch còn hiệu lực tại bucket (giao với [b, bucketEnd))
    let demand = 0;
    for (const p of periods) {
      if (p.startDate < bucketEnd && p.endDate >= b) demand += demandByPeriod.get(p.id) ?? 0;
    }
    let allocated = 0;
    for (const a of allocDates) if (a.d < bucketEnd) allocated += a.c;
    let started = 0;
    for (const s of startDates) if (s.d < bucketEnd) started += s.c;
    return { date: b, demand, allocated, started };
  });

  return {
    planning: {
      activePeriods: periods.length,
      demand: totals.demand,
      allocated: totals.allocated,
      resigned: totals.resigned,
      recruitmentNeeded: totals.recruitmentNeeded,
      fillRatePct: totals.demand > 0 ? Math.min(100, Math.round((totals.allocated / totals.demand) * 100)) : 0,
      departments: [...perDept.values()].sort((a, b) => b.gap - a.gap),
      supplyDemand,
    },
    shortageByDept,
  };
}

async function queryDataQuality(f: AnalyticsFilters, deptIds: string[] | null) {
  const { where, params } = buildApplicationWhere(f, deptIds);
  const [appRes, fpRes] = await Promise.all([
    pool.query(
      `SELECT
         count(*) FILTER (WHERE a.dw_match = 'MISMATCH' OR (a.declared_type = 'OLD' AND a.dw_match = 'NEW'))::int AS dw_mismatch,
         count(*) FILTER (WHERE a.dept_id IS NULL AND a.status = '${APPROVED_STAGE_KEY}')::int AS missing_dept,
         count(*) FILTER (WHERE a.gender IS NULL OR btrim(a.gender) = '')::int AS missing_gender,
         count(*) FILTER (WHERE a.referral_channel IS NULL OR btrim(a.referral_channel) = '')::int AS missing_referral,
         count(*) FILTER (WHERE a.age IS NOT NULL AND (a.age < 15 OR a.age > 80))::int AS abnormal_age,
         count(*) FILTER (WHERE a.starting_date IS NOT NULL AND a.starting_date < a.reg_date)::int AS starting_before_reg
       FROM daily_applications a WHERE ${where}`,
      params,
    ),
    pool.query(
      `SELECT count(DISTINCT wp.id)::int AS c
       FROM worker_profiles wp
       JOIN daily_applications a ON a.cccd = wp.cccd
       WHERE wp.deleted_at IS NULL AND wp.fingerprint_status = 'CHUA_CAP' AND ${where}`,
      params,
    ),
  ]);
  const r = appRes.rows[0] ?? {};
  const listHref = `/hr/registrations?from=${f.from}&to=${f.to}&rangeMode=1`;
  return [
    { key: "dw_mismatch", label: "Khai CŨ/MỚI lệch với DW Data", count: n(r.dw_mismatch), href: listHref },
    { key: "missing_dept", label: "Đã nhận việc nhưng chưa xếp bộ phận", count: n(r.missing_dept), href: listHref },
    { key: "missing_gender", label: "Thiếu giới tính", count: n(r.missing_gender), href: listHref },
    { key: "missing_referral", label: "Thiếu kênh giới thiệu", count: n(r.missing_referral), href: listHref },
    { key: "fingerprint_pending", label: "Chưa cấp mã vân tay (CHUA_CAP)", count: n(fpRes.rows[0]?.c), href: "/admin/worker-profiles" },
    { key: "abnormal_age", label: "Tuổi bất thường (<15 hoặc >80)", count: n(r.abnormal_age), href: listHref },
    { key: "starting_before_reg", label: "Ngày bắt đầu trước ngày đăng ký", count: n(r.starting_before_reg), href: listHref },
  ];
}

async function queryReferralChannels(scopeDeptIds: string[] | null): Promise<string[]> {
  if (scopeDeptIds !== null && scopeDeptIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT btrim(a.referral_channel) AS v
     FROM daily_applications a
     WHERE a.deleted_at IS NULL AND a.referral_channel IS NOT NULL AND btrim(a.referral_channel) <> ''
       ${scopeDeptIds !== null ? "AND a.dept_id = ANY($1::uuid[])" : ""}
     ORDER BY 1 LIMIT 60`,
    scopeDeptIds !== null ? [scopeDeptIds] : [],
  );
  return rows.map((r: NumRow) => String(r.v));
}

/** Điểm vào duy nhất — trả đủ payload cho toàn Dashboard trong 1 lần gọi. */
export async function getDashboardAnalytics(session: Session, filters: AnalyticsFilters): Promise<DashboardAnalytics> {
  const today = todayStr();
  const [scope, allDepts, stages] = await Promise.all([
    getUserScope(session),
    getScopedDepartments(),
    getWorkflowStages("daily_application"),
  ]);

  // Chỉ các department trong Data Scope được dùng cho meta + mọi phép aggregate.
  const scopedDepts = scope === null ? allDepts : allDepts.filter((d) => scope.includes(d.id));
  const deptMap = new Map(scopedDepts.map((d) => [d.id, d]));

  const matched = matchDepartmentsByHierarchy(scopedDepts, filters);
  const restriction = resolveDeptRestriction(scope, matched);
  const outOfScope = restriction !== null && restriction.length === 0;

  const days = rangeDays(filters.from, filters.to);
  const granularity = trendGranularity(days);
  const prev = previousRange(filters.from, filters.to);

  const activeStages = stages.filter((s) => s.isActive);
  const startStageKeys = activeStages.filter((s) => s.isStart).map((s) => s.stageKey);
  if (startStageKeys.length === 0) startStageKeys.push(PENDING_STAGE_FALLBACK);

  const [
    current,
    previous,
    trend,
    referralSources,
    demographics,
    workerMixRaw,
    movements,
    planningRes,
    dataQuality,
    referralChannels,
  ] = await Promise.all([
    querySummary(filters, { from: filters.from, to: filters.to }, restriction, startStageKeys, today),
    querySummary(filters, prev, restriction, startStageKeys, today),
    queryTrend(filters, restriction, granularity, today),
    queryReferral(filters, restriction, today),
    queryDemographics(filters, restriction),
    queryWorkerMix(filters, restriction),
    queryMovements(filters, restriction, granularity, deptMap),
    queryPlanning(filters, restriction, granularity, deptMap, today),
    queryDataQuality(filters, restriction),
    queryReferralChannels(scope),
  ]);

  const { planning, shortageByDept } = planningRes;
  const departmentPerformance = await queryDeptPerformance(filters, restriction, deptMap, today, shortageByDept);

  const uniq = (vals: string[]) => [...new Set(vals.filter((v) => v.trim() !== ""))].sort((a, b) => a.localeCompare(b, "vi"));

  const funnelStages = [
    { key: "applications", label: "Đăng ký", count: current.applications },
    { key: "processed", label: "Đã xử lý", count: current.processed },
    { key: "approved", label: "Đã nhận việc", count: current.approved },
    { key: "started", label: "Bắt đầu làm", count: current.started },
  ];

  return {
    range: {
      from: filters.from,
      to: filters.to,
      days,
      previousFrom: prev.from,
      previousTo: prev.to,
      granularity,
    },
    appliedFilters: filters,
    scoped: scope !== null,
    outOfScope,
    meta: {
      locations: uniq(scopedDepts.map((d) => d.location)),
      divisions: uniq(scopedDepts.map((d) => d.division)),
      sections: uniq(scopedDepts.map((d) => d.section)),
      groups: uniq(scopedDepts.map((d) => d.groupName)),
      departments: scopedDepts.sort((a, b) => a.deptName.localeCompare(b.deptName, "vi")),
      referralChannels,
      statuses: activeStages.map((s) => ({ key: s.stageKey, label: s.label, color: s.color })),
    },
    kpis: {
      applications: makeKpi(current.applications, previous.applications, "up"),
      uniqueWorkers: makeKpi(current.uniqueWorkers, previous.uniqueWorkers, "up"),
      newWorkers: makeKpi(current.newWorkers, previous.newWorkers, "up"),
      returningWorkers: makeKpi(current.returningWorkers, previous.returningWorkers, "up"),
      approved: makeKpi(current.approved, previous.approved, "up"),
      started: makeKpi(current.started, previous.started, "up"),
      // Planning engine không có snapshot lịch sử theo kỳ → không bịa previous (null = không so sánh).
      demand: makeKpi(planning?.demand ?? 0, null, "neutral"),
      shortage: makeKpi(planning?.recruitmentNeeded ?? 0, null, "down"),
    },
    funnel: {
      stages: funnelStages,
      conversions: [
        conversionPct(current.applications, current.processed),
        conversionPct(current.processed, current.approved),
        conversionPct(current.approved, current.started),
      ],
      overallConversionPct: conversionPct(current.applications, current.started),
    },
    trend: { granularity, buckets: trend },
    workerMix: {
      newWorkers: current.newWorkers,
      returningWorkers: current.returningWorkers,
      returningRatePct: conversionPct(current.uniqueWorkers, current.returningWorkers),
      uniqueWorkers: current.uniqueWorkers,
      sessions: workerMixRaw.sessionsInPeriod,
      sessionsPerWorker:
        current.uniqueWorkers > 0 && workerMixRaw.sessionsInPeriod > 0
          ? Math.round((workerMixRaw.sessionsInPeriod / current.uniqueWorkers) * 100) / 100
          : null,
    },
    referralSources,
    planning,
    departmentPerformance,
    demographics,
    movements,
    returningWorkers: {
      returningRatePct: conversionPct(current.uniqueWorkers, current.returningWorkers),
      sessionsPerWorker:
        current.uniqueWorkers > 0 && workerMixRaw.sessionsInPeriod > 0
          ? Math.round((workerMixRaw.sessionsInPeriod / current.uniqueWorkers) * 100) / 100
          : null,
      avgSessionsReturning: workerMixRaw.avgSessionsReturning,
      distribution: workerMixRaw.distribution,
      topReturningDepartments: workerMixRaw.topDeptRows
        .map((r) => {
          const meta = deptMap.get(String(r.dept_id));
          const workers = n(r.workers);
          const ret = n(r.returning);
          return {
            deptId: String(r.dept_id),
            deptName: meta?.deptName ?? "—",
            groupName: meta?.groupName ?? "",
            workers,
            returningPct: workers > 0 ? Math.round((ret / workers) * 1000) / 10 : 0,
          };
        })
        .filter((r) => r.deptName !== "—"),
    },
    dataQuality,
  };
}

/** Flat dataset cho Export Analytics (Detailed) — cùng filter + Data Scope với dashboard. */
export async function getAnalyticsDetailRows(
  session: Session,
  filters: AnalyticsFilters,
  opts: { includeCccd: boolean },
): Promise<Record<string, string>[]> {
  const scope = await getUserScope(session);
  const allDepts = await getScopedDepartments();
  const scopedDepts = scope === null ? allDepts : allDepts.filter((d) => scope.includes(d.id));
  const matched = matchDepartmentsByHierarchy(scopedDepts, filters);
  const restriction = resolveDeptRestriction(scope, matched);
  if (restriction !== null && restriction.length === 0) return [];

  const stages = await getWorkflowStages("daily_application");
  const stageLabel = new Map(stages.map((s) => [s.stageKey, s.label]));

  const { where, params } = buildApplicationWhere(filters, restriction);
  const { rows } = await pool.query(
    `SELECT to_char(a.reg_date, 'YYYY-MM-DD') AS reg_date, a.full_name, a.gender, a.age, a.cccd, a.dw_match, a.referral_channel,
        a.status, to_char(a.starting_date, 'YYYY-MM-DD') AS starting_date,
        d.location, d.division, d.dept_name, d.section, d.group_name,
        to_char(es.reg_date, 'YYYY-MM-DD') AS session_reg_date, to_char(es.end_date, 'YYYY-MM-DD') AS session_end_date
     FROM daily_applications a
     LEFT JOIN departments d ON a.dept_id = d.id
     LEFT JOIN employment_sessions es ON es.daily_application_id = a.id
     WHERE ${where}
     ORDER BY a.reg_date, d.dept_name NULLS LAST, a.full_name
     LIMIT 20000`,
    params,
  );

  return rows.map((r: Record<string, unknown>) => ({
    "Ngày đăng ký": String(r.reg_date ?? ""),
    "Họ và tên": String(r.full_name ?? ""),
    ...(opts.includeCccd ? { CCCD: String(r.cccd ?? "") } : {}),
    "Giới tính": String(r.gender ?? ""),
    "Tuổi": r.age == null ? "" : String(r.age),
    "Mới / Quay lại": r.dw_match === "MATCHED" ? "Quay lại" : "Mới",
    "Kênh giới thiệu": String(r.referral_channel ?? "") || UNKNOWN_REFERRAL_LABEL,
    "Location": String(r.location ?? ""),
    "Division": String(r.division ?? ""),
    "Bộ phận": String(r.dept_name ?? ""),
    "Section": String(r.section ?? ""),
    "Nhóm": String(r.group_name ?? ""),
    "Trạng thái": stageLabel.get(String(r.status)) ?? String(r.status ?? ""),
    "Ngày bắt đầu": String(r.starting_date ?? ""),
    "Đợt làm việc (ngày ĐK)": String(r.session_reg_date ?? ""),
    "Kết thúc đợt": String(r.session_end_date ?? ""),
  }));
}

export { bucketStart };
