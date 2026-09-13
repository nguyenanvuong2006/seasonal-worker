import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import type { DateRange } from "@/lib/date-range";

export type DailyCodeRow = {
  dailyApplicationId: string;
  cccd: string;
  fullName: string;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  startingDate: string | null;
  dwImportedAt: Date | null;
  dwDataId: string;
  code: string | null;
  dailyCodeUpdatedAt: Date | null;
  dailyCodeUpdatedBy: string | null;
};

export type DailyCodeStatusFilter = "ALL" | "MISSING" | "DONE";

export type DailyCodeListFilters = {
  /** Lọc theo 1 bộ phận cụ thể — caller (route) PHẢI tự kiểm tra deptId nằm trong Data Scope TRƯỚC khi gọi. */
  deptId?: string | null;
  /** Tìm theo họ tên / CCCD / Mã số công nhật. */
  q?: string | null;
  /** ALL (mặc định) | MISSING (chưa có mã) | DONE (đã có mã). */
  status?: DailyCodeStatusFilter;
};

/**
 * ADMINISTRATION — "Nhập mã công nhật" (mục VI). Hàng chờ = lao động ĐÃ
 * được Recruiter đưa vào DW Data (dw_imported_at IS NOT NULL), đăng ký
 * trong khoảng ngày đang chọn (GLOBAL DATE RANGE STANDARDIZATION — cột
 * `daily_applications.reg_date`, DATE column, so >= / <= is exact, no
 * timestamp half-open boundary needed). Nguồn dùng CHUNG cho cả list (GET
 * /api/administration/daily-code) và export (GET
 * /api/administration/daily-code/export) — CÙNG bộ filters
 * (range/deptId/q/status) để danh sách hiển thị và file xuất luôn khớp
 * nhau, theo đúng mẫu đã thiết lập ở lib/meal-list.ts.
 *
 * ENTITY/DEDUP KEY: one row per daily_applications.id — unchanged from the
 * single-day screen (see fingerprint-it-code-list.ts's docblock for the
 * full rationale, identical here).
 */
export async function getDailyCodeRows(
  range: DateRange,
  scope: string[] | null,
  filters: DailyCodeListFilters = {},
): Promise<DailyCodeRow[]> {
  if (scope !== null && scope.length === 0) return [];

  const conditions = [
    gte(dailyApplications.regDate, range.from),
    lte(dailyApplications.regDate, range.to),
    isNull(dailyApplications.deletedAt),
    isNotNull(dailyApplications.dwImportedAt),
  ];
  if (scope !== null) conditions.push(inArray(dailyApplications.deptId, scope));
  if (filters.deptId) conditions.push(eq(dailyApplications.deptId, filters.deptId));

  const rows = await db
    .select({
      dailyApplicationId: dailyApplications.id,
      cccd: dailyApplications.cccd,
      fullName: dailyApplications.fullName,
      deptId: dailyApplications.deptId,
      deptName: departments.deptName,
      groupName: departments.groupName,
      startingDate: dailyApplications.startingDate,
      dwImportedAt: dailyApplications.dwImportedAt,
      dwDataId: dwData.id,
      code: dwData.code,
      dailyCodeUpdatedAt: dwData.dailyCodeUpdatedAt,
      dailyCodeUpdatedBy: dwData.dailyCodeUpdatedBy,
    })
    .from(dailyApplications)
    .innerJoin(dwData, eq(dailyApplications.dwId, dwData.id))
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .where(and(...conditions))
    .orderBy(desc(dailyApplications.dwImportedAt));

  const status = filters.status ?? "ALL";
  const hasCode = (r: DailyCodeRow) => typeof r.code === "string" && r.code.trim().length > 0;
  const filtered = status === "MISSING" ? rows.filter((r) => !hasCode(r)) : status === "DONE" ? rows.filter((r) => hasCode(r)) : rows;

  const q = filters.q?.trim().toLowerCase();
  if (!q) return filtered;
  return filtered.filter(
    (r) => r.fullName.toLowerCase().includes(q) || r.cccd.includes(q) || (r.code ?? "").toLowerCase().includes(q),
  );
}
