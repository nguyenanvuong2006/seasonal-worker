import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { dailyApplications, planningPeriods, workforceMovements, workerProfiles } from "@/db/schema";
import { exportColumns, getFieldDefinitions } from "@/lib/metadata";
import { batchComputePlanningMetrics } from "@/lib/planning";
import { getUserScope, type Session } from "@/lib/auth";

/**
 * DASHBOARD FOUNDATION (nền tảng, #9) — nay đọc theo Role + Data Scope (Phase 2, Step 6):
 * ADMIN/HR_RECRUITER xem toàn công ty (scope=null); DEPT_MANAGER chỉ thấy số liệu của các
 * bộ phận được gán ở /admin/data-scopes. Widget KPI chỉ được chọn từ 1 danh sách "metric"
 * cho sẵn, AN TOÀN (không cho nhập SQL tự do). Widget TABLE đọc cột hiển thị trực tiếp từ
 * Metadata Engine (field_definitions).
 */

export const KPI_METRICS = [
  { key: "today_registrations", label: "Đăng ký hôm nay" },
  { key: "pending_count", label: "Đang chờ duyệt" },
  { key: "approved_count", label: "Đã nhận việc (tổng)" },
  { key: "dw_data_total", label: "Tổng hồ sơ trong DW Data" },
] as const;

async function computeMetric(key: string, deptScope: string[] | null): Promise<number> {
  // dw_data_total không có deptId (kho lao động chung, không thuộc riêng 1 bộ phận) —
  // luôn tính toàn công ty kể cả khi có Data Scope (đúng bản chất dữ liệu).
  if (key === "dw_data_total") {
    const { rows } = await pool.query(`SELECT count(*)::int c FROM dw_data WHERE deleted_at IS NULL`);
    return rows[0]?.c ?? 0;
  }

  const baseConditions: Record<string, string> = {
    today_registrations: `deleted_at IS NULL AND reg_date = CURRENT_DATE`,
    pending_count: `deleted_at IS NULL AND status = 'PENDING'`,
    approved_count: `deleted_at IS NULL AND status = 'APPROVED'`,
  };
  const cond = baseConditions[key];
  if (!cond) return 0;

  if (deptScope && deptScope.length === 0) return 0; // scope rỗng = không thấy gì
  if (deptScope) {
    const { rows } = await pool.query(`SELECT count(*)::int c FROM daily_applications WHERE ${cond} AND dept_id = ANY($1::uuid[])`, [deptScope]);
    return rows[0]?.c ?? 0;
  }
  const { rows } = await pool.query(`SELECT count(*)::int c FROM daily_applications WHERE ${cond}`);
  return rows[0]?.c ?? 0;
}

export async function getKpiValue(metric: string, deptScope: string[] | null = null) {
  return computeMetric(metric, deptScope);
}

/** Bảng gần nhất — cột lấy từ Metadata Engine (field_definitions, exportable=true), lọc theo Data Scope. */
export async function getRecentApplicationsTable(limit = 10, deptScope: string[] | null = null) {
  const defs = await getFieldDefinitions("daily_application");
  const cols = exportColumns(defs).slice(0, 6); // giới hạn 6 cột đầu cho gọn trên dashboard

  if (deptScope && deptScope.length === 0) {
    return { headers: cols.map((c) => c.header), rows: [] };
  }

  const rows = deptScope
    ? await db.select().from(dailyApplications).where(inArray(dailyApplications.deptId, deptScope)).orderBy(desc(dailyApplications.createdAt)).limit(limit)
    : await db.select().from(dailyApplications).orderBy(desc(dailyApplications.createdAt)).limit(limit);

  const RESOLVERS: Record<string, (r: (typeof rows)[number]) => string> = {
    da_timestamp: (r) => r.regDate,
    da_cccd: (r) => r.cccd,
    da_full_name: (r) => r.fullName,
    da_gender: (r) => r.gender ?? "",
    da_phone: (r) => r.phone,
    da_status: (r) => r.status,
    da_dw_match: (r) => r.dwMatch,
  };

  return {
    headers: cols.map((c) => c.header),
    rows: rows.map((r) => cols.map((c) => RESOLVERS[c.def.fieldKey]?.(r) ?? "")),
  };
}

/* ============================================================
   VISUAL REDESIGN V2 — Dashboard overview (read-only aggregation)
   ------------------------------------------------------------
   Feeds the "command strip / today's focus / recruitment snapshot /
   activity / planning shortage / movement alerts" composition.
   Respects Data Scope exactly like the widget API (getUserScope):
   ADMIN/HR_RECRUITER = whole company (null), DEPT_MANAGER = scoped.
   No business logic is changed — these are the same counts the
   existing widgets/pages already surface, aggregated server-side.
   ============================================================ */
export type DashboardOverview = {
  today: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    waitlist: number;
    newToDw: number;
    mismatch: number;
  };
  dwTotal: number;
  planning: {
    demandMale: number;
    demandFemale: number;
    demandTotal: number;
    allocatedMale: number;
    allocatedFemale: number;
    allocatedTotal: number;
    resignedTotal: number;
    shortageMale: number;
    shortageFemale: number;
    shortageTotal: number;
    fillRatePercent: number;
    activePeriods: number;
  } | null;
  movements: {
    pendingResignations: number;
    pendingTransfers: number;
    recent: { id: string; movementType: string; workerName: string | null; effectiveDate: string | null; status: string }[];
  };
};

export async function getDashboardOverview(session: Session): Promise<DashboardOverview> {
  const scope = await getUserScope(session);

  // 1) Today's application pipeline (plain-SQL condition, same pattern as the widget API)
  const baseCond = "deleted_at IS NULL AND reg_date = CURRENT_DATE";
  const scopedCond = scope ? `${baseCond} AND dept_id = ANY($1::uuid[])` : baseCond;
  const pipelineResult = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
       count(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
       count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
       count(*) FILTER (WHERE status = 'WAITLIST')::int AS waitlist,
       count(*) FILTER (WHERE dw_match = 'NEW')::int AS new_to_dw,
       count(*) FILTER (WHERE declared_type = 'OLD' AND dw_match = 'NEW')::int AS mismatch
     FROM daily_applications WHERE ${scopedCond}`,
    scope ? [scope] : [],
  );

  // 2) DW Data total (company-wide by nature — same behaviour as the widget API)
  const dwResult = await pool.query(`SELECT count(*)::int c FROM dw_data WHERE deleted_at IS NULL`);

  // 3) Planning: active periods within scope
  const periodRows = scope
    ? await db.select({ id: planningPeriods.id }).from(planningPeriods).where(and(eq(planningPeriods.status, "ACTIVE"), inArray(planningPeriods.departmentId, scope)))
    : await db.select({ id: planningPeriods.id }).from(planningPeriods).where(eq(planningPeriods.status, "ACTIVE"));

  let planning: DashboardOverview["planning"] = null;
  if (periodRows.length > 0) {
    const metricsMap = await batchComputePlanningMetrics(periodRows.map((r) => r.id));
    const acc = { demandMale: 0, demandFemale: 0, demandTotal: 0, allocatedMale: 0, allocatedFemale: 0, allocatedTotal: 0, resignedTotal: 0, shortageMale: 0, shortageFemale: 0, shortageTotal: 0 };
    for (const m of metricsMap.values()) {
      acc.demandMale += m.demandMale;
      acc.demandFemale += m.demandFemale;
      acc.demandTotal += m.demandTotal;
      acc.allocatedMale += m.allocatedMale;
      acc.allocatedFemale += m.allocatedFemale;
      acc.allocatedTotal += m.allocatedTotal;
      acc.resignedTotal += m.resignedTotal;
      acc.shortageMale += Math.max(0, m.demandMale - m.allocatedMale);
      acc.shortageFemale += Math.max(0, m.demandFemale - m.allocatedFemale);
    }
    acc.shortageTotal = acc.shortageMale + acc.shortageFemale;
    planning = {
      ...acc,
      fillRatePercent: acc.demandTotal > 0 ? Math.round((acc.allocatedTotal / acc.demandTotal) * 100) : 0,
      activePeriods: periodRows.length,
    };
  }

  // 4) Movement alerts (pending HR approval)
  const movWhere = scope
    ? and(eq(workforceMovements.status, "PENDING_HR"), inArray(workforceMovements.fromDeptId, scope))
    : eq(workforceMovements.status, "PENDING_HR");
  const movs = await db
    .select({
      id: workforceMovements.id,
      movementType: workforceMovements.movementType,
      workerName: workerProfiles.fullName,
      effectiveDate: workforceMovements.effectiveDate,
      status: workforceMovements.status,
    })
    .from(workforceMovements)
    .leftJoin(workerProfiles, eq(workforceMovements.workerId, workerProfiles.id))
    .where(movWhere)
    .orderBy(sql`${workforceMovements.createdAt} DESC`)
    .limit(5);

  return {
    today: {
      total: pipelineResult.rows[0]?.total ?? 0,
      pending: pipelineResult.rows[0]?.pending ?? 0,
      approved: pipelineResult.rows[0]?.approved ?? 0,
      rejected: pipelineResult.rows[0]?.rejected ?? 0,
      waitlist: pipelineResult.rows[0]?.waitlist ?? 0,
      newToDw: pipelineResult.rows[0]?.new_to_dw ?? 0,
      mismatch: pipelineResult.rows[0]?.mismatch ?? 0,
    },
    dwTotal: dwResult.rows[0]?.c ?? 0,
    planning,
    movements: {
      pendingResignations: movs.filter((m) => m.movementType === "resignation").length,
      pendingTransfers: movs.filter((m) => m.movementType === "transfer").length,
      recent: movs,
    },
  };
}
