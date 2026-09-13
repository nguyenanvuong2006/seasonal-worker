import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import { isEligibleForFingerprintQueue } from "@/lib/daily-intake-workflow";
import { classifyWorkforceEngagements, type WorkforceClassification } from "@/lib/fingerprint-classification";

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
 * ALL | MISSING (chưa có IT CODE) | DONE (đã có IT CODE) | NEW (Công nhật mới
 * đăng ký) | RETURNING (Công nhật cũ quay lại) | TRANSFERRED (Công nhật cũ
 * thuyên chuyển) — one single "Lọc" dropdown, matching the existing UI
 * pattern; NEW/RETURNING/TRANSFERRED filter by classification, MISSING/DONE
 * by IT Code presence — orthogonal dimensions, never combined server-side.
 */
export type FingerprintStatusFilter = "ALL" | "MISSING" | "DONE" | "NEW" | "RETURNING" | "TRANSFERRED";

export type FingerprintItCodeListFilters = {
  /** Lọc theo 1 bộ phận cụ thể — caller (route) PHẢI tự kiểm tra deptId nằm trong Data Scope TRƯỚC khi gọi. */
  deptId?: string | null;
  /** Tìm theo họ tên / CCCD / Mã số công nhật / IT CODE. */
  q?: string | null;
  /** ALL (mặc định) | MISSING | DONE | NEW | RETURNING | TRANSFERRED. */
  status?: FingerprintStatusFilter;
};

const CLASSIFICATION_FILTERS: readonly WorkforceClassification[] = ["NEW", "RETURNING", "TRANSFERRED"];

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

  const classificationByAppId = await classifyWorkforceEngagements(eligible.map((r) => r.dailyApplicationId));
  const withClassification: FingerprintItCodeRow[] = eligible.map((r) => ({
    ...r,
    classification: classificationByAppId.get(r.dailyApplicationId) ?? null,
  }));

  const status = filters.status ?? "ALL";
  let filtered: FingerprintItCodeRow[];
  if (status === "MISSING") filtered = withClassification.filter((r) => !r.itCode);
  else if (status === "DONE") filtered = withClassification.filter((r) => !!r.itCode);
  else if ((CLASSIFICATION_FILTERS as readonly string[]).includes(status)) filtered = withClassification.filter((r) => r.classification === status);
  else filtered = withClassification;

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
