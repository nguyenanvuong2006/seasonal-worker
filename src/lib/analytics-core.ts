/**
 * ANALYTICS CORE — phần THUẦN (pure) của Workforce Analytics Dashboard.
 * ---------------------------------------------------------------------
 * File này KHÔNG import "server-only"/DB — chứa:
 *   1. Kiểu dữ liệu (data contract) dùng chung server + client.
 *   2. Validate/parse filter từ query string (parameter validation).
 *   3. Logic thuần: previous-period, granularity, scope intersection,
 *      age bucket, % change, funnel conversion, build WHERE có tham số hoá.
 * Toàn bộ logic ở đây được unit-test trong analytics-core.test.ts mà không
 * cần database. Phần truy vấn thật nằm ở src/lib/analytics.ts (server-only).
 */

/* ============================== FILTERS ============================== */

export type WorkerTypeFilter = "ALL" | "NEW" | "RETURNING";
export type GenderFilter = "ALL" | "MALE" | "FEMALE" | "OTHER";

export type AnalyticsFilters = {
  from: string; // YYYY-MM-DD (Asia/Ho_Chi_Minh)
  to: string;
  location: string | null;
  division: string | null;
  departmentId: string | null;
  section: string | null;
  groupName: string | null;
  workerType: WorkerTypeFilter;
  gender: GenderFilter;
  referralChannel: string | null; // giá trị gốc hoặc UNKNOWN_REFERRAL
  status: string | null; // stageKey của workflow daily_application
};

/** Giá trị đặc biệt cho filter "Kênh giới thiệu" = trống/null. */
export const UNKNOWN_REFERRAL = "__UNKNOWN__";
/** Nhãn hiển thị cho kênh giới thiệu trống/null. */
export const UNKNOWN_REFERRAL_LABEL = "Không xác định";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Giới hạn range tối đa (an toàn hiệu năng) — 2 năm. */
export const MAX_RANGE_DAYS = 731;

function cleanText(v: string | null, maxLen = 160): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (!s || s === "ALL") return null;
  return s.slice(0, maxLen);
}

export function isValidDateStr(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Cộng/trừ ngày trên chuỗi YYYY-MM-DD (tính bằng UTC — không phụ thuộc TZ server). */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function rangeDays(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z").getTime();
  const b = new Date(to + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Kỳ so sánh = khoảng NGAY TRƯỚC kỳ đang chọn, cùng số ngày (không phải "tháng trước"). */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const days = rangeDays(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { from: prevFrom, to: prevTo };
}

export type Granularity = "DAY" | "WEEK" | "MONTH";

/** <=31 ngày: DAILY; 32–180: WEEKLY; >180: MONTHLY. */
export function trendGranularity(days: number): Granularity {
  if (days <= 31) return "DAY";
  if (days <= 180) return "WEEK";
  return "MONTH";
}

export type ParseFiltersResult =
  | { ok: true; filters: AnalyticsFilters }
  | { ok: false; error: string };

/**
 * Parse + validate filter từ query string. `todayVn` = todayStr() theo Asia/Ho_Chi_Minh.
 * Mặc định: 30 ngày gần nhất.
 */
export function parseAnalyticsFilters(params: URLSearchParams, todayVn: string): ParseFiltersResult {
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  const to = rawTo && rawTo.trim() ? rawTo.trim() : todayVn;
  const from = rawFrom && rawFrom.trim() ? rawFrom.trim() : addDays(to, -29);

  if (!isValidDateStr(from) || !isValidDateStr(to)) {
    return { ok: false, error: "Ngày không hợp lệ (định dạng YYYY-MM-DD)." };
  }
  if (from > to) return { ok: false, error: "Khoảng thời gian không hợp lệ: từ ngày phải trước đến ngày." };
  if (rangeDays(from, to) > MAX_RANGE_DAYS) {
    return { ok: false, error: `Khoảng thời gian tối đa ${MAX_RANGE_DAYS} ngày.` };
  }

  const departmentId = cleanText(params.get("departmentId"), 40);
  if (departmentId && !UUID_RE.test(departmentId)) {
    return { ok: false, error: "departmentId không hợp lệ." };
  }

  const workerTypeRaw = (params.get("workerType") || "ALL").toUpperCase();
  if (!["ALL", "NEW", "RETURNING"].includes(workerTypeRaw)) {
    return { ok: false, error: "workerType không hợp lệ (ALL/NEW/RETURNING)." };
  }
  const genderRaw = (params.get("gender") || "ALL").toUpperCase();
  if (!["ALL", "MALE", "FEMALE", "OTHER"].includes(genderRaw)) {
    return { ok: false, error: "gender không hợp lệ (ALL/MALE/FEMALE/OTHER)." };
  }

  return {
    ok: true,
    filters: {
      from,
      to,
      location: cleanText(params.get("location")),
      division: cleanText(params.get("division")),
      departmentId,
      section: cleanText(params.get("section")),
      groupName: cleanText(params.get("groupName")),
      workerType: workerTypeRaw as WorkerTypeFilter,
      gender: genderRaw as GenderFilter,
      referralChannel: cleanText(params.get("referralChannel")),
      status: cleanText(params.get("status"), 40),
    },
  };
}

/* ============================ SCOPE LOGIC ============================ */

/**
 * Kết hợp Data Scope (getUserScope) với danh sách department khớp filter hierarchy.
 *   - scope = null  → không giới hạn theo quyền.
 *   - matched = null → user không lọc theo hierarchy.
 * Trả về: null = không giới hạn dept; [] = không thấy gì; [ids] = giới hạn đúng các dept đó.
 * Nếu filter yêu cầu dept ngoài scope → giao của 2 tập = [] (không leak aggregate).
 */
export function resolveDeptRestriction(
  scope: string[] | null,
  matched: string[] | null,
): string[] | null {
  if (scope === null && matched === null) return null;
  if (scope === null) return matched;
  if (matched === null) return scope;
  const set = new Set(scope);
  return matched.filter((id) => set.has(id));
}

export type DeptMeta = {
  id: string;
  deptName: string;
  groupName: string;
  vnName: string | null;
  location: string;
  division: string;
  section: string;
};

/** Lọc department theo filter hierarchy (thuần, không SQL). So sánh không phân biệt hoa/thường. */
export function matchDepartmentsByHierarchy(depts: DeptMeta[], f: AnalyticsFilters): string[] | null {
  const hasFilter = !!(f.location || f.division || f.departmentId || f.section || f.groupName);
  if (!hasFilter) return null;
  const eqi = (a: string | null | undefined, b: string) =>
    (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
  return depts
    .filter((d) => {
      if (f.departmentId && d.id !== f.departmentId) return false;
      if (f.location && !eqi(d.location, f.location)) return false;
      if (f.division && !eqi(d.division, f.division)) return false;
      if (f.section && !eqi(d.section, f.section)) return false;
      if (f.groupName && !eqi(d.groupName, f.groupName)) return false;
      return true;
    })
    .map((d) => d.id);
}

/* ===================== PARAMETERIZED WHERE BUILDER ===================== */

export type BuiltWhere = { where: string; params: unknown[] };

/**
 * SQL expression phân loại giới tính — PHẢI khớp semantics isFemale/isMale (src/lib/helpers.ts):
 * ưu tiên Nữ trước, không phân loại được = OTHER.
 */
export function genderClassSql(col: string): string {
  return `CASE
    WHEN ${col} IS NULL OR btrim(${col}) = '' THEN 'OTHER'
    WHEN lower(${col}) LIKE '%nữ%' OR lower(btrim(${col})) IN ('nu', 'f', 'female') OR lower(${col}) LIKE '%nu %' THEN 'FEMALE'
    WHEN lower(${col}) LIKE '%nam%' OR lower(btrim(${col})) IN ('m', 'male') THEN 'MALE'
    ELSE 'OTHER'
  END`;
}

/**
 * FUNNEL SEMANTIC MAPPING (centralized — lý do: Workflow Engine mô tả "các status hợp lệ"
 * nhưng KHÔNG mô tả nghĩa phân tích "Processed/Started". Đây là nơi DUY NHẤT ánh xạ
 * business-semantic đó, không rải hard-code status khắp component):
 *   - Applications = mọi đơn trong kỳ (deleted_at IS NULL).
 *   - Processed    = status KHÔNG còn ở bước bắt đầu (workflow_stages.isStart) — tức HR đã xử lý.
 *   - Approved     = status = 'APPROVED' (stageKey chuẩn của Workflow Engine, xem DEFAULT_WORKFLOW_STAGES).
 *   - Started      = Approved + starting_date đã tới (<= hôm nay theo Asia/Ho_Chi_Minh).
 */
export const APPROVED_STAGE_KEY = "APPROVED";
export const PENDING_STAGE_FALLBACK = "PENDING";

export function startedConditionSql(alias: string, todayParamIdx: number): string {
  const p = `$${todayParamIdx}`;
  return `${alias}.status = '${APPROVED_STAGE_KEY}' AND ${alias}.starting_date IS NOT NULL AND ${alias}.starting_date <= ${p}::date`;
}

/**
 * Build WHERE có THAM SỐ HOÁ cho daily_applications (alias `a`).
 * KHÔNG bao giờ nối trực tiếp giá trị user vào SQL — mọi giá trị đi qua params ($n).
 * `deptIds`: null = không giới hạn; [] = không thấy gì (sinh điều kiện FALSE).
 */
export function buildApplicationWhere(
  f: { from: string; to: string; workerType: WorkerTypeFilter; gender: GenderFilter; referralChannel: string | null; status: string | null },
  deptIds: string[] | null,
  alias = "a",
): BuiltWhere {
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds: string[] = [`${alias}.deleted_at IS NULL`];

  conds.push(`${alias}.reg_date >= ${push(f.from)}::date`);
  conds.push(`${alias}.reg_date <= ${push(f.to)}::date`);

  if (deptIds !== null) {
    if (deptIds.length === 0) {
      conds.push("FALSE"); // scope rỗng / filter ngoài scope — không trả bất kỳ dòng nào
    } else {
      conds.push(`${alias}.dept_id = ANY(${push(deptIds)}::uuid[])`);
    }
  }

  if (f.workerType === "NEW") conds.push(`${alias}.dw_match <> 'MATCHED'`);
  if (f.workerType === "RETURNING") conds.push(`${alias}.dw_match = 'MATCHED'`);

  if (f.gender !== "ALL") {
    conds.push(`(${genderClassSql(`${alias}.gender`)}) = ${push(f.gender)}`);
  }

  if (f.referralChannel) {
    if (f.referralChannel === UNKNOWN_REFERRAL) {
      conds.push(`(${alias}.referral_channel IS NULL OR btrim(${alias}.referral_channel) = '')`);
    } else {
      conds.push(`lower(btrim(coalesce(${alias}.referral_channel, ''))) = lower(btrim(${push(f.referralChannel)}))`);
    }
  }

  if (f.status) {
    conds.push(`${alias}.status = ${push(f.status)}`);
  }

  return { where: conds.join(" AND "), params };
}

/* ============================ CALCULATIONS ============================ */

/** % thay đổi so kỳ trước; null nếu kỳ trước = 0 (tránh chia 0 / hiển thị ∞). */
export function pctChange(current: number, previous: number | null): number | null {
  if (previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Conversion % (b trên a); null nếu a = 0. */
export function conversionPct(a: number, b: number): number | null {
  if (a <= 0) return null;
  return Math.round((b / a) * 1000) / 10;
}

export const AGE_BUCKETS = ["<18", "18–24", "25–34", "35–44", "45–54", "55+", "Không rõ"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/** Bucket tuổi — tuổi lấy từ dữ liệu server (cột age), KHÔNG tính lại theo timezone client. */
export function ageBucket(age: number | null | undefined): AgeBucket {
  if (age == null || !Number.isFinite(age) || age <= 0 || age > 120) return "Không rõ";
  if (age < 18) return "<18";
  if (age <= 24) return "18–24";
  if (age <= 34) return "25–34";
  if (age <= 44) return "35–44";
  if (age <= 54) return "45–54";
  return "55+";
}

export const SESSION_DISTRIBUTION_LABELS = ["1 đợt", "2 đợt", "3 đợt", "4+ đợt"] as const;

export function sessionCountBucketIndex(count: number): number {
  if (count <= 1) return 0;
  if (count === 2) return 1;
  if (count === 3) return 2;
  return 3;
}

/* ============================ DATA CONTRACT ============================ */

export type KpiDirection = "up" | "down" | "flat";
/** goodWhen: "up" = tăng là tốt; "down" = tăng là xấu (vd Còn thiếu); "neutral" = không đánh giá. */
export type KpiValue = {
  current: number;
  previous: number | null;
  changePct: number | null;
  direction: KpiDirection;
  goodWhen: "up" | "down" | "neutral";
};

export function makeKpi(current: number, previous: number | null, goodWhen: KpiValue["goodWhen"]): KpiValue {
  const changePct = pctChange(current, previous);
  let direction: KpiDirection = "flat";
  if (previous !== null) {
    if (current > previous) direction = "up";
    else if (current < previous) direction = "down";
  }
  return { current, previous, changePct, direction, goodWhen };
}

export type FunnelStage = { key: string; label: string; count: number };

export type TrendBucket = {
  date: string; // ngày đầu bucket (YYYY-MM-DD)
  applications: number;
  approved: number;
  started: number;
  newCount: number;
  returningCount: number;
};

export type ReferralSourceRow = {
  source: string; // đã normalize; blank/null = UNKNOWN_REFERRAL_LABEL
  applications: number;
  approved: number;
  started: number;
  conversionPct: number | null; // Application -> Started
};

export type DeptPerformanceRow = DeptMeta & {
  registered: number;
  approved: number;
  started: number;
  currentWorkforce: number;
  shortage: number;
};

export type PlanningDeptRow = {
  deptId: string;
  deptName: string;
  groupName: string;
  vnName: string | null;
  demand: number;
  allocated: number;
  gap: number; // recruitmentNeeded từ planning engine hiện có
  fillRatePct: number;
};

export type SupplyDemandPoint = {
  date: string;
  demand: number; // tổng nhu cầu các kế hoạch ACTIVE còn hiệu lực TẠI thời điểm này (point-in-time, không cộng dồn theo ngày)
  allocated: number; // số phân bổ đã tồn tại tới thời điểm này (allocated_at <= date)
  started: number; // luỹ kế số người bắt đầu làm trong kỳ tới thời điểm này
};

export type MovementTrendBucket = { date: string; resignations: number; transfers: number };

export type MovementDeptRow = {
  deptId: string;
  deptName: string;
  groupName: string;
  resignations: number;
  transfersIn: number;
  transfersOut: number;
  total: number;
};

export type DataQualityItem = { key: string; label: string; count: number; href: string | null };

export type AnalyticsMeta = {
  locations: string[];
  divisions: string[];
  sections: string[];
  groups: string[];
  departments: DeptMeta[];
  referralChannels: string[];
  statuses: { key: string; label: string; color: string }[];
};

export type DashboardAnalytics = {
  range: {
    from: string;
    to: string;
    days: number;
    previousFrom: string;
    previousTo: string;
    granularity: Granularity;
  };
  appliedFilters: AnalyticsFilters;
  scoped: boolean; // user có Data Scope giới hạn
  outOfScope: boolean; // filter yêu cầu dept ngoài scope → toàn bộ số liệu = 0, không leak
  meta: AnalyticsMeta;
  kpis: {
    applications: KpiValue;
    uniqueWorkers: KpiValue;
    newWorkers: KpiValue;
    returningWorkers: KpiValue;
    approved: KpiValue;
    started: KpiValue;
    demand: KpiValue; // "Nhu cầu tuyển" — planning engine, không có snapshot lịch sử nên previous=null
    shortage: KpiValue; // "Còn thiếu" = recruitmentNeeded từ planning engine
  };
  funnel: {
    stages: FunnelStage[]; // Applications -> Processed -> Approved -> Started
    conversions: (number | null)[]; // stage-to-stage %
    overallConversionPct: number | null; // Applications -> Started
  };
  trend: { granularity: Granularity; buckets: TrendBucket[] };
  workerMix: {
    newWorkers: number;
    returningWorkers: number;
    returningRatePct: number | null;
    uniqueWorkers: number;
    sessions: number;
    sessionsPerWorker: number | null;
  };
  referralSources: ReferralSourceRow[];
  planning: {
    activePeriods: number;
    demand: number;
    allocated: number;
    resigned: number;
    recruitmentNeeded: number;
    fillRatePct: number;
    departments: PlanningDeptRow[];
    supplyDemand: SupplyDemandPoint[];
  } | null;
  departmentPerformance: DeptPerformanceRow[];
  demographics: {
    gender: { male: number; female: number; other: number };
    age: { bucket: string; count: number }[];
  };
  movements: {
    pending: { resignations: number; transfers: number };
    requested: { resignations: number; transfers: number }; // yêu cầu ĐƯỢC TẠO trong kỳ
    effective: { resignations: number; transfersIn: number; transfersOut: number }; // đã có hiệu lực trong kỳ
    trend: MovementTrendBucket[];
    topDepartments: MovementDeptRow[];
  };
  returningWorkers: {
    returningRatePct: number | null; // "Tỷ lệ lao động quay lại" — KHÔNG gọi là retention
    sessionsPerWorker: number | null;
    avgSessionsReturning: number | null;
    distribution: { label: string; count: number }[];
    topReturningDepartments: { deptId: string; deptName: string; groupName: string; workers: number; returningPct: number }[];
  };
  dataQuality: DataQualityItem[];
};

/* ==================== TREND BUCKET HELPERS (pure) ==================== */

/** Ngày đầu bucket của 1 ngày bất kỳ theo granularity (WEEK = thứ 2, giống date_trunc của Postgres). */
export function bucketStart(dateStr: string, g: Granularity): string {
  if (g === "DAY") return dateStr;
  const d = new Date(dateStr + "T00:00:00Z");
  if (g === "WEEK") {
    const dow = d.getUTCDay(); // 0 = CN
    const diff = dow === 0 ? 6 : dow - 1;
    d.setUTCDate(d.getUTCDate() - diff);
    return d.toISOString().slice(0, 10);
  }
  return dateStr.slice(0, 8) + "01";
}

/** Danh sách đầy đủ các bucket trong range (kể cả bucket không có dữ liệu — chart không bị đứt). */
export function enumerateBuckets(from: string, to: string, g: Granularity): string[] {
  const out: string[] = [];
  let cur = bucketStart(from, g);
  const guard = 1000;
  for (let i = 0; i < guard && cur <= to; i++) {
    out.push(cur);
    if (g === "DAY") cur = addDays(cur, 1);
    else if (g === "WEEK") cur = addDays(cur, 7);
    else {
      const d = new Date(cur + "T00:00:00Z");
      d.setUTCMonth(d.getUTCMonth() + 1);
      cur = d.toISOString().slice(0, 10);
    }
  }
  return out;
}

/** Nhãn hiển thị bucket (vi-VN, không phụ thuộc TZ). */
export function bucketLabel(dateStr: string, g: Granularity): string {
  const [y, m, d] = dateStr.split("-");
  if (g === "MONTH") return `${m}/${y}`;
  if (g === "WEEK") return `Tuần ${d}/${m}`;
  return `${d}/${m}`;
}
