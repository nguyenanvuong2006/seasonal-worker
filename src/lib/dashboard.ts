import "server-only";
import { desc, inArray } from "drizzle-orm";
import { db, pool } from "@/db";
import { dailyApplications } from "@/db/schema";
import { exportColumns, getFieldDefinitions } from "@/lib/metadata";

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
  { key: "approved_count", label: "Đã duyệt (tổng)" },
  { key: "dw_data_total", label: "Tổng lao động trong DW Data" },
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
