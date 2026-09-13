import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import { isEligibleForFingerprintQueue } from "@/lib/daily-intake-workflow";
import { classifyWorkforceEngagements, type WorkforceClassification } from "@/lib/fingerprint-classification";
import type { DateRange } from "@/lib/date-range";

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
  /** NEW/RETURNING/TRANSFERRED, derived from employment_sessions + workforce_movements — see fingerprint-classification.ts. null when the row has no employment_sessions entry yet (not yet classifiable). */
  classification: WorkforceClassification | null;
};

/**
 * "Loại công nhật" — independent from IT Code status (mission: identity &
 * IT Code contract review section 14). ALL | NEW | RETURNING | TRANSFERRED.
 */
export type FingerprintClassificationFilter = "ALL" | WorkforceClassification;

/**
 * "Trạng thái IT Code" — whether dw_data.it_code has been assigned yet.
 * Independent from classification: a worker can be RETURNING+MISSING,
 * TRANSFERRED+HAS, etc. — never conflate the two into one dropdown
 * (GLOBAL DATE RANGE STANDARDIZATION mission section 14).
 */
export type ItCodeStatusFilter = "ALL" | "MISSING" | "HAS";

export type FingerprintItCodeListFilters = {
  /** Lọc theo 1 bộ phận cụ thể — caller (route) PHẢI tự kiểm tra deptId nằm trong Data Scope TRƯỚC khi gọi. */
  deptId?: string | null;
  /** Tìm theo họ tên / CCCD / Mã số công nhật / IT CODE. */
  q?: string | null;
  /** ALL (mặc định) | NEW | RETURNING | TRANSFERRED. */
  classification?: FingerprintClassificationFilter;
  /** ALL (mặc định) | MISSING | HAS. */
  itCodeStatus?: ItCodeStatusFilter;
};

/**
 * FINGERPRINT_STAFF — "IT Code / Vân tay" (mục VIII). Hàng chờ = lao động
 * đã nhập DW Data VÀ đã có Mã số công nhật (dw_data.code) — xem
 * lib/daily-intake-workflow.ts#isEligibleForFingerprintQueue, nguồn DUY
 * NHẤT cho điều kiện này. Nguồn dùng CHUNG cho cả list (GET
 * /api/fingerprint/it-code) và export (GET /api/fingerprint/it-code/export)
 * — CÙNG bộ filters (range/deptId/q/classification/itCodeStatus) để danh
 * sách hiển thị và file xuất luôn khớp nhau.
 *
 * DATE SEMANTICS (GLOBAL DATE RANGE STANDARDIZATION): the date column is
 * `daily_applications.reg_date` — the SAME registration-date semantics the
 * single-day screen always used, now inclusive over [range.from, range.to].
 * `reg_date` is a DATE column, so a plain >= / <= comparison is exact — no
 * timestamp half-open boundary needed here.
 *
 * ENTITY/DEDUP KEY: one row per `daily_applications.id` (one row per
 * registration/engagement), unchanged from the single-day screen. A worker
 * who registered on two different days already produced two distinct rows
 * in the old single-day view (viewed on each of those two days
 * separately) — extending to a multi-day range simply shows both rows
 * together; this is not double-counting the same registration, it is two
 * real, distinct daily_applications rows for two real, distinct
 * registration events.
 */
export async function getFingerprintItCodeRows(
  range: DateRange,
  scope: string[] | null,
  filters: FingerprintItCodeListFilters = {},
): Promise<FingerprintItCodeRow[]> {
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

  const classificationByAppId = await classifyWorkforceEngagements(eligible.map((r) => r.dailyApplicationId));
  const withClassification: FingerprintItCodeRow[] = eligible.map((r) => ({
    ...r,
    classification: classificationByAppId.get(r.dailyApplicationId) ?? null,
  }));

  const itCodeStatus = filters.itCodeStatus ?? "ALL";
  const byItCodeStatus =
    itCodeStatus === "MISSING"
      ? withClassification.filter((r) => !r.itCode)
      : itCodeStatus === "HAS"
        ? withClassification.filter((r) => !!r.itCode)
        : withClassification;

  const classification = filters.classification ?? "ALL";
  const byClassification = classification === "ALL" ? byItCodeStatus : byItCodeStatus.filter((r) => r.classification === classification);

  const q = filters.q?.trim().toLowerCase();
  if (!q) return byClassification;
  return byClassification.filter(
    (r) =>
      r.fullName.toLowerCase().includes(q) ||
      r.cccd.includes(q) ||
      (r.code ?? "").toLowerCase().includes(q) ||
      (r.itCode ?? "").toLowerCase().includes(q),
  );
}
