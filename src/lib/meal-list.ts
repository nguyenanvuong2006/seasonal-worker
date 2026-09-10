import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import { isEligibleForMealExport } from "@/lib/daily-intake-workflow";

export type MealEligibleRow = {
  dailyApplicationId: string;
  cccd: string;
  fullName: string;
  phone: string;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  startingDate: string | null;
  code: string | null;
};

export type MealStatusFilter = "ALL" | "ELIGIBLE" | "INELIGIBLE";

export type MealListFilters = {
  /** Lọc theo 1 bộ phận cụ thể — caller (route) PHẢI tự kiểm tra deptId nằm trong Data Scope TRƯỚC khi gọi. */
  deptId?: string | null;
  /** Tìm theo họ tên / Mã số công nhật / CCCD — đúng 3 trường theo thiết kế privacy (mục IX). */
  q?: string | null;
  /** ELIGIBLE (mặc định, giữ hành vi cũ) | INELIGIBLE (đã nhập DW nhưng chưa có Mã số công nhật) | ALL. */
  status?: MealStatusFilter;
};

/**
 * MEAL_STAFF — "Báo cơm" (mục IX). Điều kiện ĐỦ ĐIỀU KIỆN: đã nhập DW Data
 * VÀ đã có Mã số công nhật. KHÔNG yêu cầu IT CODE (mục IX, XV — cấm dùng IT
 * CODE làm blocker Meal). "KHÔNG ĐỦ ĐIỀU KIỆN" (status=INELIGIBLE) là điều
 * kiện phủ định AN TOÀN của cùng quy tắc đó — KHÔNG phải một khái niệm
 * nghiệp vụ mới: đã nhập DW (tức đã ở trong hàng chờ vận hành trong ngày)
 * nhưng chưa có Mã số công nhật. Nguồn dùng CHUNG cho cả list (GET
 * /api/meal) và export (GET /api/meal/export) — CÙNG bộ filters
 * (date/deptId/q/status) để danh sách hiển thị và file xuất luôn khớp nhau
 * (mục IX: "không export toàn bộ Daily Application rồi để người dùng tự lọc").
 */
export async function getMealEligibleWorkers(
  date: string,
  scope: string[] | null,
  filters: MealListFilters = {},
): Promise<MealEligibleRow[]> {
  if (scope !== null && scope.length === 0) return [];

  const conditions = [
    eq(dailyApplications.regDate, date),
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
      phone: dailyApplications.phone,
      deptId: dailyApplications.deptId,
      deptName: departments.deptName,
      groupName: departments.groupName,
      startingDate: dailyApplications.startingDate,
      dwImportedAt: dailyApplications.dwImportedAt,
      code: dwData.code,
    })
    .from(dailyApplications)
    .innerJoin(dwData, eq(dailyApplications.dwId, dwData.id))
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .where(and(...conditions))
    .orderBy(desc(dailyApplications.dwImportedAt));

  const status = filters.status ?? "ELIGIBLE";
  const isEligible = (r: (typeof rows)[number]) => isEligibleForMealExport({ status: "APPROVED", dwImportedAt: r.dwImportedAt }, { code: r.code });
  const scoped = status === "ELIGIBLE" ? rows.filter(isEligible) : status === "INELIGIBLE" ? rows.filter((r) => !isEligible(r)) : rows;
  const shaped = scoped.map(({ dwImportedAt: _dwImportedAt, ...rest }) => rest);

  const q = filters.q?.trim().toLowerCase();
  if (!q) return shaped;
  return shaped.filter(
    (r) => r.fullName.toLowerCase().includes(q) || r.cccd.includes(q) || (r.code ?? "").toLowerCase().includes(q),
  );
}
