import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  departments,
  recruitmentRequests,
  planningPeriods,
  planningTargets,
  planningAllocations,
  employmentSessions,
  workerProfiles,
  workforceMovements,
  type RecruitmentRequest,
  type NewRecruitmentRequest,
} from "@/db/schema";
import { isFemale, isMale } from "@/lib/helpers";
import {
  mapRowToCanonical,
  validateRow,
  parseDate,
  toInt,
  computeBalanceFromCanonical,
  normalizeStatus,
  normalizeHeaderName,
  resolveHeaderAlias,
} from "@/lib/recruitment-request-utils";

export type { RecruitmentRequest, NewRecruitmentRequest };
export {
  normalizeHeaderName,
  resolveHeaderAlias,
  mapRowToCanonical,
  validateRow,
  parseDate,
  toInt,
  computeBalanceFromCanonical,
  normalizeStatus,
};

/* ============================================================
   IMPORT — transaction-safe, idempotent theo Request Code
   ============================================================ */
export type ImportRowResult = {
  rowIndex: number;
  status: "INSERTED" | "UPDATED" | "SKIPPED" | "ERROR";
  requestCode: string;
  message: string;
};

export async function importRecruitmentRequests(
  rows: Record<string, string>[],
  createdBy: string,
  options?: { skipDuplicates?: boolean; updateDuplicates?: boolean },
): Promise<ImportRowResult[]> {
  const results: ImportRowResult[] = [];
  const skip = options?.skipDuplicates ?? false;
  const update = options?.updateDuplicates ?? true;

  for (let i = 0; i < rows.length; i++) {
    try {
      const raw = rows[i];
      const { canonical, unknownHeaders } = mapRowToCanonical(raw);
      const validation = validateRow(canonical);

      if (!validation.valid) {
        results.push({
          rowIndex: i + 1,
          status: "ERROR",
          requestCode: canonical["Request Code"] || `Row ${i + 1}`,
          message: validation.errors.map((e) => e.message).join("; "),
        });
        continue;
      }

      const requestCode = canonical["Request Code"]?.trim() ?? "";
      if (!requestCode) {
        results.push({ rowIndex: i + 1, status: "ERROR", requestCode: "", message: "Thiếu Request Code" });
        continue;
      }

      // Check for existing
      const existing = await db
        .select({ id: recruitmentRequests.id })
        .from(recruitmentRequests)
        .where(and(eq(recruitmentRequests.requestCode, requestCode), isNull(recruitmentRequests.deletedAt)))
        .limit(1);

      if (existing.length > 0) {
        if (skip) {
          results.push({ rowIndex: i + 1, status: "SKIPPED", requestCode, message: "Request Code đã tồn tại, bỏ qua" });
          continue;
        }
        if (update) {
          const balance = computeBalanceFromCanonical(canonical);
          await db
            .update(recruitmentRequests)
            .set({
              requester: canonical["Requester"] ?? "",
              position: canonical["Position"] ?? null,
              jobTitle: canonical["Job title"] ?? null,
              location: canonical["Location"] ?? null,
              section: canonical["Section"] ?? null,
              groupName: canonical["Group"] ?? null,
              division: canonical["Division"] ?? null,
              department: canonical["Department"] ?? null,
              reason: canonical["Reason"] ?? null,
              noteForReason: canonical["Note for reason"] ?? null,
              specialRequirements: canonical["Special Requirements"] ?? null,
              maleRq: toInt(canonical["Male Rq"]),
              femaleRq: toInt(canonical["Female Rq"]),
              maleApplication: toInt(canonical["Male Application"]),
              femaleApplication: toInt(canonical["Female Application"]),
              maleInterviewed: toInt(canonical["Male Interviewed"]),
              femaleInterviewed: toInt(canonical["Female Interviewed"]),
              maleRecruited: toInt(canonical["Male Recruited"]),
              femaleRecruited: toInt(canonical["Female Recruited"]),
              maleQuit: toInt(canonical["Male Quit"]),
              femaleQuit: toInt(canonical["Female Quit"]),
              maleBalance: balance.maleBalance,
              femaleBalance: balance.femaleBalance,
              totalBalance: balance.totalBalance,
              status: normalizeStatus(canonical["Status"]) ?? "PENDING",
              requestedDate: parseDate(canonical["Requested Date"] ?? ""),
              expectedDate: parseDate(canonical["Expected Date"] ?? ""),
              offeredDate: parseDate(canonical["Offered Date"] ?? ""),
              completedDate: parseDate(canonical["Completed Date"] ?? ""),
              month: canonical["Month"] ?? null,
              cost: toInt(canonical["Cost"]),
              remarks: canonical["Remarks"] ?? null,
              to: canonical["To"] ?? null,
              rqStatus: canonical["Rq Status"] ?? null,
              monthRc: canonical["Month_Rc"] ?? null,
              totalRequest: toInt(canonical["Total Request"]),
              recruitedVsExpected: toInt(canonical["Recruited vs Expected"]),
              screened: toInt(canonical["Screened"]),
              interview: toInt(canonical["Interview"]),
              recruit: toInt(canonical["Recruit"]),
              departmentText: canonical["Department"] ?? null,
              monthReport: canonical["Month_Report"] ?? null,
              updatedAt: new Date(),
            })
            .where(eq(recruitmentRequests.id, existing[0].id));

          results.push({ rowIndex: i + 1, status: "UPDATED", requestCode, message: "Đã cập nhật" });
        } else {
          results.push({ rowIndex: i + 1, status: "SKIPPED", requestCode, message: "Request Code đã tồn tại" });
        }
        continue;
      }

      // Insert new
      const balance = computeBalanceFromCanonical(canonical);
      await db.insert(recruitmentRequests).values({
        requestCode,
        requester: canonical["Requester"] ?? "",
        position: canonical["Position"] ?? null,
        jobTitle: canonical["Job title"] ?? null,
        location: canonical["Location"] ?? null,
        section: canonical["Section"] ?? null,
        groupName: canonical["Group"] ?? null,
        division: canonical["Division"] ?? null,
        department: canonical["Department"] ?? null,
        reason: canonical["Reason"] ?? null,
        noteForReason: canonical["Note for reason"] ?? null,
        specialRequirements: canonical["Special Requirements"] ?? null,
        maleRq: toInt(canonical["Male Rq"]),
        femaleRq: toInt(canonical["Female Rq"]),
        maleApplication: toInt(canonical["Male Application"]),
        femaleApplication: toInt(canonical["Female Application"]),
        maleInterviewed: toInt(canonical["Male Interviewed"]),
        femaleInterviewed: toInt(canonical["Female Interviewed"]),
        maleRecruited: toInt(canonical["Male Recruited"]),
        femaleRecruited: toInt(canonical["Female Recruited"]),
        maleQuit: toInt(canonical["Male Quit"]),
        femaleQuit: toInt(canonical["Female Quit"]),
        maleBalance: balance.maleBalance,
        femaleBalance: balance.femaleBalance,
        totalBalance: balance.totalBalance,
        status: normalizeStatus(canonical["Status"]) ?? "PENDING",
        requestedDate: parseDate(canonical["Requested Date"] ?? ""),
        expectedDate: parseDate(canonical["Expected Date"] ?? ""),
        offeredDate: parseDate(canonical["Offered Date"] ?? ""),
        completedDate: parseDate(canonical["Completed Date"] ?? ""),
        month: canonical["Month"] ?? null,
        cost: toInt(canonical["Cost"]),
        remarks: canonical["Remarks"] ?? null,
        to: canonical["To"] ?? null,
        rqStatus: canonical["Rq Status"] ?? null,
        monthRc: canonical["Month_Rc"] ?? null,
        totalRequest: toInt(canonical["Total Request"]),
        recruitedVsExpected: toInt(canonical["Recruited vs Expected"]),
        screened: toInt(canonical["Screened"]),
        interview: toInt(canonical["Interview"]),
        recruit: toInt(canonical["Recruit"]),
        departmentText: canonical["Department"] ?? null,
        monthReport: canonical["Month_Report"] ?? null,
        createdBy,
      });

      results.push({ rowIndex: i + 1, status: "INSERTED", requestCode, message: "Đã thêm mới" });
    } catch (err) {
      results.push({
        rowIndex: i + 1,
        status: "ERROR",
        requestCode: rows[i]?.["Request Code"]?.trim() ?? `Row ${i + 1}`,
        message: (err as Error).message,
      });
    }
  }

  return results;
}

/* ============================================================
   CRUD OPERATIONS
   ============================================================ */
export type RecruitmentRequestFilter = {
  month?: string;
  location?: string;
  division?: string;
  department?: string;
  section?: string;
  group?: string;
  status?: string;
  requester?: string;
  searchQuery?: string;
  scope?: string[] | null;
};

export async function listRecruitmentRequests(
  filter: RecruitmentRequestFilter,
  limit = 500,
  offset = 0,
): Promise<{ rows: RecruitmentRequest[]; total: number }> {
  const conditions: any[] = [isNull(recruitmentRequests.deletedAt)];

  if (filter.scope !== null && filter.scope !== undefined) {
    if (filter.scope.length === 0) return { rows: [], total: 0 };
    conditions.push(inArray(recruitmentRequests.department, filter.scope));
  }
  if (filter.month) conditions.push(eq(recruitmentRequests.month, filter.month));
  if (filter.location) conditions.push(eq(recruitmentRequests.location, filter.location));
  if (filter.division) conditions.push(eq(recruitmentRequests.division, filter.division));
  if (filter.department) conditions.push(eq(recruitmentRequests.department, filter.department));
  if (filter.section) conditions.push(eq(recruitmentRequests.section, filter.section));
  if (filter.group) conditions.push(eq(recruitmentRequests.groupName, filter.group));
  if (filter.status) conditions.push(eq(recruitmentRequests.status, filter.status));
  if (filter.requester) conditions.push(eq(recruitmentRequests.requester, filter.requester));
  if (filter.searchQuery?.trim()) {
    const q = `%${filter.searchQuery.trim()}%`;
    conditions.push(
      or(
        like(recruitmentRequests.requestCode, q),
        like(recruitmentRequests.requester, q),
        like(recruitmentRequests.department, q),
        like(recruitmentRequests.position, q),
        like(recruitmentRequests.jobTitle, q),
        like(recruitmentRequests.location, q),
      )!,
    );
  }

  const where = conditions.length > 1 ? and(...conditions) : conditions[0];

  const [totalResult, rows] = await Promise.all([
    db.select({ count: count() }).from(recruitmentRequests).where(where),
    db
      .select()
      .from(recruitmentRequests)
      .where(where)
      .orderBy(desc(recruitmentRequests.createdAt))
      .limit(limit)
      .offset(offset),
  ]);

  return { rows, total: totalResult[0]?.count ?? 0 };
}

export async function getRecruitmentRequest(id: string): Promise<RecruitmentRequest | null> {
  const [row] = await db
    .select()
    .from(recruitmentRequests)
    .where(and(eq(recruitmentRequests.id, id), isNull(recruitmentRequests.deletedAt)));
  return row ?? null;
}

export async function batchUpdateStatus(
  ids: string[],
  status: string,
  updatedBy: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db
    .update(recruitmentRequests)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        inArray(recruitmentRequests.id, ids),
        isNull(recruitmentRequests.deletedAt),
      ),
    );
  return result.rowCount ?? 0;
}

export async function softDeleteRecruitmentRequests(
  ids: string[],
  deletedBy: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db
    .update(recruitmentRequests)
    .set({ deletedAt: new Date(), deletedBy, updatedAt: new Date() })
    .where(
      and(
        inArray(recruitmentRequests.id, ids),
        isNull(recruitmentRequests.deletedAt),
      ),
    );
  return result.rowCount ?? 0;
}

export async function deleteRecruitmentRequestPermanent(id: string): Promise<boolean> {
  const result = await db.delete(recruitmentRequests).where(eq(recruitmentRequests.id, id));
  return (result.rowCount ?? 0) > 0;
}

/* ============================================================
   THỐNG KÊ — TỔNG HỢP NHANH
   ============================================================ */
export type RecruitmentStats = {
  totalRequests: number;
  pending: number;
  processing: number;
  completed: number;
  cancelled: number;
  totalMaleRq: number;
  totalFemaleRq: number;
  totalMaleRecruited: number;
  totalFemaleRecruited: number;
  totalMaleBalance: number;
  totalFemaleBalance: number;
  totalBalance: number;
};

export async function getRecruitmentStats(scope?: string[] | null): Promise<RecruitmentStats> {
  const conditions: any[] = [isNull(recruitmentRequests.deletedAt)];
  if (scope !== null && scope !== undefined && scope.length > 0) {
    conditions.push(inArray(recruitmentRequests.department, scope));
  } else if (scope !== null && scope !== undefined && scope.length === 0) {
    return {
      totalRequests: 0, pending: 0, processing: 0, completed: 0, cancelled: 0,
      totalMaleRq: 0, totalFemaleRq: 0, totalMaleRecruited: 0, totalFemaleRecruited: 0,
      totalMaleBalance: 0, totalFemaleBalance: 0, totalBalance: 0,
    };
  }

  const where = conditions.length > 1 ? and(...conditions) : conditions[0];

  const [statusCounts, sums] = await Promise.all([
    db
      .select({
        status: recruitmentRequests.status,
        count: count(),
      })
      .from(recruitmentRequests)
      .where(where)
      .groupBy(recruitmentRequests.status),
    db
      .select({
        maleRq: sql<number>`COALESCE(SUM(${recruitmentRequests.maleRq}), 0)`,
        femaleRq: sql<number>`COALESCE(SUM(${recruitmentRequests.femaleRq}), 0)`,
        maleRecruited: sql<number>`COALESCE(SUM(${recruitmentRequests.maleRecruited}), 0)`,
        femaleRecruited: sql<number>`COALESCE(SUM(${recruitmentRequests.femaleRecruited}), 0)`,
        maleBalance: sql<number>`COALESCE(SUM(${recruitmentRequests.maleBalance}), 0)`,
        femaleBalance: sql<number>`COALESCE(SUM(${recruitmentRequests.femaleBalance}), 0)`,
        totalBalance: sql<number>`COALESCE(SUM(${recruitmentRequests.totalBalance}), 0)`,
      })
      .from(recruitmentRequests)
      .where(where),
  ]);

  const statusMap = new Map(statusCounts.map((r) => [r.status, r.count]));
  const s = sums[0] ?? { maleRq: 0, femaleRq: 0, maleRecruited: 0, femaleRecruited: 0, maleBalance: 0, femaleBalance: 0, totalBalance: 0 };

  return {
    totalRequests: statusCounts.reduce((acc, r) => acc + r.count, 0),
    pending: statusMap.get("PENDING") ?? 0,
    processing: statusMap.get("PROCESSING") ?? 0,
    completed: statusMap.get("COMPLETED") ?? 0,
    cancelled: statusMap.get("CANCELLED") ?? 0,
    totalMaleRq: s.maleRq,
    totalFemaleRq: s.femaleRq,
    totalMaleRecruited: s.maleRecruited,
    totalFemaleRecruited: s.femaleRecruited,
    totalMaleBalance: s.maleBalance,
    totalFemaleBalance: s.femaleBalance,
    totalBalance: s.totalBalance,
  };
}

/* ============================================================
   HIERARCHY MATCH — Location → Division → Department → Section → Group
   Khớp với cấu trúc Dalat Hasfarm
   ============================================================ */
export async function matchHierarchy(
  location?: string | null,
  division?: string | null,
  department?: string | null,
  section?: string | null,
  group?: string | null,
): Promise<{ deptId: string | null; matched: boolean }> {
  const conditions: any[] = [isNull(departments.deletedAt)];
  if (location) conditions.push(eq(departments.location, location));
  if (division) conditions.push(eq(departments.division, division));
  if (department) conditions.push(eq(departments.deptName, department));
  if (section) conditions.push(eq(departments.section, section));
  if (group) conditions.push(eq(departments.groupName, group));

  if (conditions.length <= 1) return { deptId: null, matched: false };

  const [dept] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(...conditions))
    .limit(1);

  return { deptId: dept?.id ?? null, matched: !!dept };
}