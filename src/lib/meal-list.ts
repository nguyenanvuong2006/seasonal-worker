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

/**
 * MEAL_STAFF — "Báo cơm" (mục IX). Điều kiện: đã nhập DW Data VÀ đã có Mã số
 * công nhật. KHÔNG yêu cầu IT CODE (mục IX, XV — cấm dùng IT CODE làm blocker
 * Meal). Nguồn dùng CHUNG cho cả list (GET /api/meal) và export (GET
 * /api/meal/export) — tránh 2 nơi lọc khác nhau (mục IX: "không export toàn
 * bộ Daily Application rồi để người dùng tự lọc").
 */
export async function getMealEligibleWorkers(date: string, scope: string[] | null): Promise<MealEligibleRow[]> {
  if (scope !== null && scope.length === 0) return [];

  const conditions = [
    eq(dailyApplications.regDate, date),
    isNull(dailyApplications.deletedAt),
    isNotNull(dailyApplications.dwImportedAt),
  ];
  if (scope !== null) conditions.push(inArray(dailyApplications.deptId, scope));

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

  return rows
    .filter((r) => isEligibleForMealExport({ status: "APPROVED", dwImportedAt: r.dwImportedAt }, { code: r.code }))
    .map(({ dwImportedAt: _dwImportedAt, ...rest }) => rest);
}
