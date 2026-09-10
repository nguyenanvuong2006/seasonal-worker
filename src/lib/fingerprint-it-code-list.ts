import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import { isEligibleForFingerprintQueue } from "@/lib/daily-intake-workflow";

export type FingerprintItCodeRow = {
  dailyApplicationId: string;
  cccd: string;
  fullName: string;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  dwImportedAt: Date | null;
  dwDataId: string;
  code: string | null;
  itCode: string | null;
  itCodeUpdatedAt: Date | null;
  itCodeUpdatedBy: string | null;
};

export type FingerprintStatusFilter = "ALL" | "MISSING" | "DONE";

export type FingerprintItCodeListFilters = {
  /** Lọc theo 1 bộ phận cụ thể — caller (route) PHẢI tự kiểm tra deptId nằm trong Data Scope TRƯỚC khi gọi. */
  deptId?: string | null;
  /** Tìm theo họ tên / CCCD / Mã số công nhật / IT CODE. */
  q?: string | null;
  /** ALL (mặc định) | MISSING (chưa có IT CODE) | DONE (đã có IT CODE). */
  status?: FingerprintStatusFilter;
};

/**
 * FINGERPRINT_STAFF — "IT Code / Vân tay" (mục VIII). Hàng chờ = lao động
 * đã nhập DW Data VÀ đã có Mã số công nhật (dw_data.code) — xem
 * lib/daily-intake-workflow.ts#isEligibleForFingerprintQueue, nguồn DUY
 * NHẤT cho điều kiện này. Nguồn dùng CHUNG cho cả list (GET
 * /api/fingerprint/it-code) và export (GET /api/fingerprint/it-code/export)
 * — CÙNG bộ filters (date/deptId/q/status) để danh sách hiển thị và file
 * xuất luôn khớp nhau, theo đúng mẫu đã thiết lập ở lib/meal-list.ts.
 */
export async function getFingerprintItCodeRows(
  date: string,
  scope: string[] | null,
  filters: FingerprintItCodeListFilters = {},
): Promise<FingerprintItCodeRow[]> {
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
      deptId: dailyApplications.deptId,
      deptName: departments.deptName,
      groupName: departments.groupName,
      dwImportedAt: dailyApplications.dwImportedAt,
      dwDataId: dwData.id,
      code: dwData.code,
      itCode: dwData.itCode,
      itCodeUpdatedAt: dwData.itCodeUpdatedAt,
      itCodeUpdatedBy: dwData.itCodeUpdatedBy,
    })
    .from(dailyApplications)
    .innerJoin(dwData, eq(dailyApplications.dwId, dwData.id))
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .where(and(...conditions))
    .orderBy(desc(dailyApplications.dwImportedAt));

  const eligible = rows.filter((r) => isEligibleForFingerprintQueue({ status: "APPROVED", dwImportedAt: r.dwImportedAt }, { code: r.code }));

  const status = filters.status ?? "ALL";
  const filtered =
    status === "MISSING" ? eligible.filter((r) => !r.itCode) : status === "DONE" ? eligible.filter((r) => !!r.itCode) : eligible;

  const q = filters.q?.trim().toLowerCase();
  if (!q) return filtered;
  return filtered.filter(
    (r) =>
      r.fullName.toLowerCase().includes(q) ||
      r.cccd.includes(q) ||
      (r.code ?? "").toLowerCase().includes(q) ||
      (r.itCode ?? "").toLowerCase().includes(q),
  );
}
