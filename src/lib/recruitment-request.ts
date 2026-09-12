import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  dailyApplications,
  departments,
  recruitmentRequests,
  type RecruitmentRequest,
  type NewRecruitmentRequest,
} from "@/db/schema";
import { SORTABLE_COLUMN_KEYS } from "@/lib/recruitment-request-columns";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { isFemale, isMale, todayStr } from "@/lib/helpers";
import { RECRUITED_STAGE, batchComputeRequestKpis } from "@/lib/workforce-request";
import { resolveDefaultAsOf, type RequestKpi } from "@/lib/workforce-request-kpi";
import {
  computeDateDeltas,
  computeRecruitedVsExpected,
  computeTotalRequest,
} from "@/lib/planning-recruitment-core";
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
import { provisionRecruitmentRequest } from "@/lib/recruitment-request-provisioning";

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

/**
 * Cột hệ thống (SYSTEM/DERIVED — xem SYSTEM_OWNED_COLUMN_KEYS) mà import KHÔNG
 * bao giờ ghi đè, dù Excel có giá trị (Phase 2B mục 5). Trả về tên cột Excel
 * nào có giá trị non-blank đã bị bỏ qua — để báo minh bạch cho người import,
 * KHÔNG âm thầm nuốt.
 */
const IGNORED_SYSTEM_EXCEL_COLUMNS = ["Male Recruited", "Female Recruited", "Male Quit", "Female Quit"] as const;

function detectIgnoredSystemFields(canonical: Record<string, string>): string[] {
  return IGNORED_SYSTEM_EXCEL_COLUMNS.filter((header) => (canonical[header] ?? "").trim() !== "");
}

/**
 * Import yêu cầu tuyển dụng từ Excel / Google Sheets.
 *
 * - TRANSACTION-SAFE: toàn bộ lô chạy trong MỘT transaction. Một dòng lỗi
 *   nghiệp vụ chỉ được ghi nhận vào kết quả (không làm hỏng cả lô); lỗi hạ
 *   tầng làm rollback toàn bộ để không để lại dữ liệu nửa vời.
 * - IDEMPOTENT theo Request Code: chạy lại cùng một file không tạo bản trùng
 *   (update hoặc skip theo `options`).
 * - KHÔNG GHI ĐÈ KPI HỆ THỐNG (Yêu cầu #10): Balance, Total Request và
 *   Recruited vs Expected luôn được TÍNH LẠI, bỏ qua giá trị trong file.
 */
export async function importRecruitmentRequests(
  rows: Record<string, string>[],
  createdBy: string,
  options?: { skipDuplicates?: boolean; updateDuplicates?: boolean },
  scope: string[] | null = null,
): Promise<ImportRowResult[]> {
  const results: ImportRowResult[] = [];
  const skip = options?.skipDuplicates ?? false;
  const update = options?.updateDuplicates ?? true;

  // Các Request Code đã xử lý trong CHÍNH lô này — chặn trùng nội bộ file
  // (Excel hay có 2 dòng cùng mã) mà không cần round-trip DB.
  const seenInBatch = new Set<string>();

  await db.transaction(async (tx) => {
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

      if (seenInBatch.has(requestCode)) {
        results.push({
          rowIndex: i + 1,
          status: "SKIPPED",
          requestCode,
          message: "Request Code bị lặp trong chính file import, chỉ nhận dòng đầu tiên",
        });
        continue;
      }
      seenInBatch.add(requestCode);

      // KPI DERIVED — tính từ dữ liệu nguồn, KHÔNG lấy từ Excel (Yêu cầu #10).
      // recruitedVsExpected KHÔNG được tính từ "Male/Female Recruited" của Excel nữa
      // (Phase 2B mục 5 audit — trước đây tự mâu thuẫn: import bỏ qua các cột hệ thống
      // NHƯNG recruitedVsExpected vẫn âm thầm dùng chính 2 cột đó) — tính lại bên dưới,
      // riêng theo từng nhánh insert/update, từ daily_applications thật (canonical KPI).
      const totalRequest = computeTotalRequest(toInt(canonical["Male Rq"]), toInt(canonical["Female Rq"]));
      const ignoredSystemFields = detectIgnoredSystemFields(canonical);
      const deltas = computeDateDeltas({
        requestedDate: parseDate(canonical["Requested Date"] ?? ""),
        offeredDate: parseDate(canonical["Offered Date"] ?? ""),
        completedDate: parseDate(canonical["Completed Date"] ?? ""),
      });
      // Khớp cây tổ chức để có department_id — Data Scope lọc theo FK này.
      const { deptId: departmentId } = await matchHierarchy(
        canonical["Location"],
        canonical["Division"],
        canonical["Department"],
        canonical["Section"],
        canonical["Group"],
      );

      // B1 (Production Recovery audit) — TRƯỚC ĐÂY mỗi dòng chạy try/catch NHƯNG dùng CHUNG 1
      // transaction/connection (`tx`) với mọi dòng khác. Nếu 1 dòng làm Postgres raise lỗi SQL
      // thật (vd value too long cho varchar, CHECK constraint) thì theo ngữ nghĩa Postgres, TOÀN
      // BỘ transaction bị "aborted" — mọi câu lệnh sau đó (kể cả của các dòng hợp lệ phía sau)
      // đều fail với 25P02, bị catch ở đây và ghi nhầm thành ERROR của TỪNG dòng, RỒI vì catch
      // không re-throw nên outer transaction vẫn chạy tới COMMIT — Postgres âm thầm hạ COMMIT
      // trên 1 aborted transaction thành ROLLBACK, KHÔNG báo lỗi. Kết quả: UI báo "N dòng đã
      // insert" nhưng DB có 0 dòng thật — mất dữ liệu im lặng, báo cáo thành công giả.
      // Fix: mỗi dòng chạy trong SAVEPOINT riêng (`tx.transaction()` lồng nhau — drizzle-orm
      // node-postgres dùng SAVEPOINT/ROLLBACK TO SAVEPOINT cho transaction lồng nhau thật). Lỗi
      // 1 dòng chỉ rollback đúng savepoint của dòng đó — transaction ngoài (và các dòng khác)
      // không bị ảnh hưởng.
      const rowResult = await tx.transaction(async (tx2) => {
        // Check for existing
        const existing = await tx2
          .select({ id: recruitmentRequests.id, departmentId: recruitmentRequests.departmentId })
          .from(recruitmentRequests)
          .where(and(eq(recruitmentRequests.requestCode, requestCode), isNull(recruitmentRequests.deletedAt)))
          .limit(1);

        if (existing.length > 0) {
          // IDOR fix (Production Recovery audit) — TRƯỚC ĐÂY chỉ scope-check phòng ban CỦA DÒNG
          // ĐANG IMPORT (route.ts), không re-check phòng ban của record ĐANG BỊ GHI ĐÈ. Request
          // Code là mã nghiệp vụ dễ đoán/lộ (không phải UUID bí mật) — 1 tài khoản scope-hạn-chế
          // có thể "chiếm" (ghi đè toàn bộ dữ liệu + đổi departmentId) 1 request thuộc phòng ban
          // KHÁC chỉ bằng cách import 1 dòng trùng Request Code với Location/Dept giải quyết về
          // phòng ban CỦA HỌ. Chặn tại đây — nguồn ghi duy nhất của cả import lẫn paste-import.
          if (!scopeAllowsDepartment(scope, existing[0].departmentId)) {
            return {
              status: "ERROR" as const,
              message: "Request Code đã tồn tại thuộc phòng ban ngoài Data Scope được cấp — không thể ghi đè.",
            };
          }
          if (skip) {
            return { status: "SKIPPED" as const, message: "Request Code đã tồn tại, bỏ qua" };
          }
          if (update) {
            // Yêu cầu #C/#D — Balance được tính lại bởi provisionRecruitmentRequest()
            // (snapshot cố định + Quit During Request live), KHÔNG dùng Current
            // realtime trực tiếp ở đây và KHÔNG reset snapshot đã có (mục C: "Không
            // overwrite snapshot khi import lại cùng Request Code").
            const maleRq = toInt(canonical["Male Rq"]);
            const femaleRq = toInt(canonical["Female Rq"]);
            const requestedDateVal = parseDate(canonical["Requested Date"] ?? "");
            const expectedDateVal = parseDate(canonical["Expected Date"] ?? "");
            const startingDateVal = parseDate(canonical["Starting Date"] ?? "");
            const endDateVal = parseDate(canonical["End Date"] ?? "");
            const statusVal = normalizeStatus(canonical["Status"]) ?? "PENDING";
            // recruitedVsExpected (DERIVED) — Phase 2B mục 5: tính từ daily_applications
            // THẬT của request này (nguồn canonical KPI dùng — RECRUITED_STAGE), KHÔNG
            // từ "Male/Female Recruited" của Excel. maleRecruited/femaleRecruited/
            // maleQuit/femaleQuit (SYSTEM) KHÔNG còn nằm trong payload UPDATE — giữ
            // nguyên giá trị hệ thống đã tính, không bị Excel ghi đè (mục 10).
            const liveRecruited = await tx2
              .select({ gender: dailyApplications.gender })
              .from(dailyApplications)
              .where(
                and(
                  eq(dailyApplications.requestId, existing[0].id),
                  eq(dailyApplications.status, RECRUITED_STAGE),
                  isNull(dailyApplications.deletedAt),
                ),
              );
            const liveRecruitedVsExpected = computeRecruitedVsExpected(
              liveRecruited.filter((r) => isMale(r.gender)).length,
              liveRecruited.filter((r) => isFemale(r.gender)).length,
              totalRequest,
            );
            await tx2
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
                maleRq,
                femaleRq,
                maleApplication: toInt(canonical["Male Application"]),
                femaleApplication: toInt(canonical["Female Application"]),
                maleInterviewed: toInt(canonical["Male Interviewed"]),
                femaleInterviewed: toInt(canonical["Female Interviewed"]),
                status: statusVal,
                requestedDate: requestedDateVal,
                expectedDate: expectedDateVal,
                startingDate: startingDateVal,
                endDate: endDateVal,
                offeredDate: parseDate(canonical["Offered Date"] ?? ""),
                completedDate: parseDate(canonical["Completed Date"] ?? ""),
                ...deltas,
                departmentId,
                month: canonical["Month"] ?? null,
                cost: toInt(canonical["Cost"]),
                remarks: canonical["Remarks"] ?? null,
                to: canonical["To"] ?? null,
                rqStatus: canonical["Rq Status"] ?? null,
                monthRc: canonical["Month_Rc"] ?? null,
                // DERIVED — luôn tính lại, KHÔNG lấy giá trị Excel (Yêu cầu #10).
                totalRequest,
                recruitedVsExpected: liveRecruitedVsExpected,
                screened: toInt(canonical["Screened"]),
                interview: toInt(canonical["Interview"]),
                recruit: toInt(canonical["Recruit"]),
                departmentText: canonical["Department"] ?? null,
                monthReport: canonical["Month_Report"] ?? null,
                updatedAt: new Date(),
              })
              .where(eq(recruitmentRequests.id, existing[0].id));

            // Snapshot (nếu chưa có) + auto-link Planning + auto-allocate — idempotent,
            // an toàn gọi lại khi import trùng Request Code (mục Q).
            await provisionRecruitmentRequest(tx2, {
              requestId: existing[0].id,
              departmentId,
              maleRq,
              femaleRq,
              location: canonical["Location"] ?? null,
              division: canonical["Division"] ?? null,
              section: canonical["Section"] ?? null,
              groupName: canonical["Group"] ?? null,
              startingDate: startingDateVal,
              expectedDate: expectedDateVal,
              requestedDate: requestedDateVal,
              endDate: endDateVal,
              status: statusVal,
              actor: createdBy,
            });

            return {
              status: "UPDATED" as const,
              message: ignoredSystemFields.length > 0
                ? `Đã cập nhật. Các cột do hệ thống tự tính đã được bỏ qua: ${ignoredSystemFields.join(", ")}.`
                : "Đã cập nhật",
            };
          }
          return { status: "SKIPPED" as const, message: "Request Code đã tồn tại" };
        }

        // Insert new
        // Balance ban đầu = Rq (chưa snapshot) — provisionRecruitmentRequest() bên
        // dưới sẽ snapshot Current Workforce THEO DEPARTMENT và ghi lại Balance
        // đúng công thức (mục C/D) NGAY sau khi có request.id.
        const maleRq = toInt(canonical["Male Rq"]);
        const femaleRq = toInt(canonical["Female Rq"]);
        const requestedDateVal = parseDate(canonical["Requested Date"] ?? "");
        const expectedDateVal = parseDate(canonical["Expected Date"] ?? "");
        const startingDateVal = parseDate(canonical["Starting Date"] ?? "");
        const endDateVal = parseDate(canonical["End Date"] ?? "");
        const statusVal = normalizeStatus(canonical["Status"]) ?? "PENDING";
        const balance = computeBalanceFromCanonical(canonical);
        const [inserted] = await tx2
          .insert(recruitmentRequests)
          .values({
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
            maleRq,
            femaleRq,
            maleApplication: toInt(canonical["Male Application"]),
            femaleApplication: toInt(canonical["Female Application"]),
            maleInterviewed: toInt(canonical["Male Interviewed"]),
            femaleInterviewed: toInt(canonical["Female Interviewed"]),
            // maleRecruited/femaleRecruited/maleQuit/femaleQuit (SYSTEM) — KHÔNG lấy
            // từ Excel (Phase 2B mục 5). Request mới luôn bắt đầu từ 0 (mặc định DB) —
            // đúng nguyên tắc đã áp dụng ở POST /api/recruitment-requests.
            maleBalance: balance.maleBalance,
            femaleBalance: balance.femaleBalance,
            totalBalance: balance.totalBalance,
            status: statusVal,
            requestedDate: requestedDateVal,
            expectedDate: expectedDateVal,
            startingDate: startingDateVal,
            endDate: endDateVal,
            offeredDate: parseDate(canonical["Offered Date"] ?? ""),
            completedDate: parseDate(canonical["Completed Date"] ?? ""),
            ...deltas,
            departmentId,
            month: canonical["Month"] ?? null,
            cost: toInt(canonical["Cost"]),
            remarks: canonical["Remarks"] ?? null,
            to: canonical["To"] ?? null,
            rqStatus: canonical["Rq Status"] ?? null,
            monthRc: canonical["Month_Rc"] ?? null,
            // DERIVED — luôn tính lại, KHÔNG lấy giá trị Excel (Yêu cầu #10).
            totalRequest,
            // recruitedVsExpected (DERIVED) — request MỚI không thể có daily_applications
            // nào liên kết trước khi request.id tồn tại -> luôn 0, KHÔNG lấy từ Excel.
            recruitedVsExpected: 0,
            screened: toInt(canonical["Screened"]),
            interview: toInt(canonical["Interview"]),
            recruit: toInt(canonical["Recruit"]),
            departmentText: canonical["Department"] ?? null,
            monthReport: canonical["Month_Report"] ?? null,
            createdBy,
          })
          .returning({ id: recruitmentRequests.id });

        // SNAPSHOT Current Workforce + auto-link Planning + auto-allocate ACTIVE
        // workforce theo Department (mục C, E, F, G) — chạy ngay khi request mới
        // được tạo, trong CÙNG transaction để đảm bảo tính nguyên tử.
        await provisionRecruitmentRequest(tx2, {
          requestId: inserted.id,
          departmentId,
          maleRq,
          femaleRq,
          location: canonical["Location"] ?? null,
          division: canonical["Division"] ?? null,
          section: canonical["Section"] ?? null,
          groupName: canonical["Group"] ?? null,
          startingDate: startingDateVal,
          expectedDate: expectedDateVal,
          requestedDate: requestedDateVal,
          endDate: endDateVal,
          status: statusVal,
          actor: createdBy,
        });

        return {
          status: "INSERTED" as const,
          message: ignoredSystemFields.length > 0
            ? `Đã thêm mới. Các cột do hệ thống tự tính đã được bỏ qua: ${ignoredSystemFields.join(", ")}.`
            : "Đã thêm mới",
        };
      });

      results.push({ rowIndex: i + 1, status: rowResult.status, requestCode, message: rowResult.message });
    } catch (err) {
      results.push({
        rowIndex: i + 1,
        status: "ERROR",
        requestCode: rows[i]?.["Request Code"]?.trim() ?? `Row ${i + 1}`,
        message: (err as Error).message,
      });
    }
  }
  });

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
  reason?: string;
  requester?: string;
  searchQuery?: string;
  scope?: string[] | null;
  /** Lọc theo khoảng Ngày yêu cầu (yyyy-MM-dd). */
  requestedFrom?: string;
  requestedTo?: string;
  /** Lọc theo khoảng Ngày cần nhân lực (yyyy-MM-dd). */
  expectedFrom?: string;
  expectedTo?: string;
  /** Tình trạng đáp ứng: còn thiếu người / đã đủ. */
  fulfillment?: "UNFILLED" | "FILLED";
  /**
   * Cột sắp xếp — khoá cột trong catalog (recruitment-request-columns) hoặc
   * "createdAt". Bỏ trống = sắp xếp mặc định theo Ngày cần nhân lực (Yêu cầu #5).
   * Khoá không nằm trong whitelist sẽ bị bỏ qua và quay về mặc định.
   */
  sortBy?: string;
  sortDir?: "asc" | "desc";
};

/**
 * C2 (Mission C — Product Consolidation): bounded candidate cap for the
 * canonical-KPI list path below — mirrors the existing export route's own
 * precedent (a fixed high cap, no offset) rather than adding any stored KPI
 * cache table. UNFILLED/FILLED and the default sort bucket can only be
 * decided AFTER computing the canonical, allocation-aware KPI (never the
 * stale persisted totalBalance column), so those two cases fetch a bounded
 * candidate set and filter/sort/paginate in memory; every other filter
 * combination (explicit sortBy, no fulfillment filter) keeps the original
 * single SQL query + COUNT(*) path unchanged — no perf regression there.
 */
const MAX_KPI_CANDIDATES = 2000;

function isRecognizedSortKey(sortBy: string | undefined): boolean {
  return sortBy === "createdAt" || sortBy === "expectedDate" || (!!sortBy && sortBy in SORTABLE_DB_COLUMNS);
}

function needsCanonicalKpiForListing(filter: RecruitmentRequestFilter): boolean {
  return filter.fulfillment !== undefined || !isRecognizedSortKey(filter.sortBy);
}

function compareNullsLast<T>(a: T | null | undefined, b: T | null | undefined, dirMul: number, cmp: (x: T, y: T) => number): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return dirMul * cmp(a as T, b as T);
}

const scalarCompare = (x: unknown, y: unknown): number => {
  if (x instanceof Date && y instanceof Date) return x.getTime() - y.getTime();
  if (typeof x === "number" && typeof y === "number") return x - y;
  return String(x).localeCompare(String(y));
};

/**
 * In-memory sort mirroring buildOrderBy()'s semantics exactly, but reading
 * the CANONICAL kpi.totalBalance (via the supplied map) for the default
 * bucket instead of the stale recruitmentRequests.totalBalance column.
 */
function sortRowsCanonical(
  rows: RecruitmentRequest[],
  filter: RecruitmentRequestFilter,
  kpiByRequestId: Map<string, RequestKpi>,
  today: string,
): RecruitmentRequest[] {
  const dirMul = filter.sortDir === "desc" ? -1 : 1;
  const tiebreak = (a: RecruitmentRequest, b: RecruitmentRequest) => a.requestCode.localeCompare(b.requestCode);

  if (filter.sortBy === "createdAt") {
    return [...rows].sort((a, b) => compareNullsLast(a.createdAt, b.createdAt, dirMul, scalarCompare) || tiebreak(a, b));
  }
  if (filter.sortBy === "expectedDate") {
    return [...rows].sort((a, b) => compareNullsLast(a.expectedDate, b.expectedDate, dirMul, scalarCompare) || tiebreak(a, b));
  }
  if (filter.sortBy && filter.sortBy in SORTABLE_DB_COLUMNS) {
    const key = filter.sortBy as keyof RecruitmentRequest;
    return [...rows].sort((a, b) => compareNullsLast(a[key], b[key], dirMul, scalarCompare) || tiebreak(a, b));
  }

  // Default bucket (Yêu cầu #5) — CANONICAL Balance, not the stale column.
  const bucketOf = (r: RecruitmentRequest): number => {
    if (!r.expectedDate) return 2;
    const balance = kpiByRequestId.get(r.id)?.totalBalance ?? 0;
    if (r.expectedDate < today && balance > 0 && r.status !== "COMPLETED" && r.status !== "CANCELLED") return 0;
    return 1;
  };
  return [...rows].sort((a, b) => {
    const bucketDiff = bucketOf(a) - bucketOf(b);
    if (bucketDiff !== 0) return bucketDiff;
    const dateDiff = compareNullsLast(a.expectedDate, b.expectedDate, 1, scalarCompare);
    if (dateDiff !== 0) return dateDiff;
    return tiebreak(a, b);
  });
}

export async function listRecruitmentRequests(
  filter: RecruitmentRequestFilter,
  limit = 500,
  offset = 0,
): Promise<{ rows: RecruitmentRequest[]; total: number }> {
  const conditions: any[] = [isNull(recruitmentRequests.deletedAt)];

  // DATA SCOPE (Yêu cầu #15) — lọc theo KHOÁ NGOẠI department_id, không phải
  // tên phòng ban dạng text. getUserScope() trả về UUID phòng ban; so sánh với
  // cột text `department` sẽ luôn rỗng và Dept Manager không thấy gì.
  if (filter.scope !== null && filter.scope !== undefined) {
    if (filter.scope.length === 0) return { rows: [], total: 0 };
    conditions.push(inArray(recruitmentRequests.departmentId, filter.scope));
  }
  if (filter.month) conditions.push(eq(recruitmentRequests.month, filter.month));
  if (filter.location) conditions.push(eq(recruitmentRequests.location, filter.location));
  if (filter.division) conditions.push(eq(recruitmentRequests.division, filter.division));
  if (filter.department) conditions.push(eq(recruitmentRequests.department, filter.department));
  if (filter.section) conditions.push(eq(recruitmentRequests.section, filter.section));
  if (filter.group) conditions.push(eq(recruitmentRequests.groupName, filter.group));
  if (filter.status) conditions.push(eq(recruitmentRequests.status, filter.status));
  if (filter.reason) conditions.push(eq(recruitmentRequests.reason, filter.reason));
  if (filter.requester) conditions.push(eq(recruitmentRequests.requester, filter.requester));
  if (filter.requestedFrom) conditions.push(gte(recruitmentRequests.requestedDate, filter.requestedFrom));
  if (filter.requestedTo) conditions.push(lte(recruitmentRequests.requestedDate, filter.requestedTo));
  if (filter.expectedFrom) conditions.push(gte(recruitmentRequests.expectedDate, filter.expectedFrom));
  if (filter.expectedTo) conditions.push(lte(recruitmentRequests.expectedDate, filter.expectedTo));
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

  if (!needsCanonicalKpiForListing(filter)) {
    // Fast path — explicit non-default sortBy, no fulfillment filter: neither
    // needs canonical KPI, keep the original single SQL query + COUNT(*).
    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(recruitmentRequests).where(where),
      db
        .select()
        .from(recruitmentRequests)
        .where(where)
        .orderBy(...buildOrderBy(filter))
        .limit(limit)
        .offset(offset),
    ]);
    return { rows, total: totalResult[0]?.count ?? 0 };
  }

  // CANONICAL PATH (C2) — bounded candidate fetch + batchComputeRequestKpis +
  // in-memory filter/sort/paginate. UNFILLED/FILLED and the default sort
  // bucket must agree with every other canonical consumer (Request Detail,
  // Export, get_recruitment_stats, dashboard) — none of them may read the
  // stale totalBalance column.
  const candidates = await db
    .select()
    .from(recruitmentRequests)
    .where(where)
    .orderBy(desc(recruitmentRequests.createdAt))
    .limit(MAX_KPI_CANDIDATES);
  if (candidates.length === MAX_KPI_CANDIDATES) {
    // Independent review finding: beyond this bound, `total` and sort order
    // are only exact within the newest MAX_KPI_CANDIDATES rows — accepted,
    // bounded architecture (Mission C — no stored KPI cache table), but must
    // be visible in Production if it's ever actually hit, never silent.
    console.warn(
      `[listRecruitmentRequests] candidate fetch hit MAX_KPI_CANDIDATES (${MAX_KPI_CANDIDATES}) — UNFILLED/FILLED filter, default sort, and total count are an approximation over the newest ${MAX_KPI_CANDIDATES} requests, not exact.`,
    );
  }

  const today = todayStr();
  const candidatesById = new Map(candidates.map((r) => [r.id, r]));
  const kpiByRequestId = await batchComputeRequestKpis(candidates, (r) => resolveDefaultAsOf(candidatesById.get(r.id)!, today));

  let filtered = candidates;
  if (filter.fulfillment === "UNFILLED") filtered = filtered.filter((r) => (kpiByRequestId.get(r.id)?.totalBalance ?? 0) > 0);
  else if (filter.fulfillment === "FILLED") filtered = filtered.filter((r) => (kpiByRequestId.get(r.id)?.totalBalance ?? 0) === 0);

  const sorted = sortRowsCanonical(filtered, filter, kpiByRequestId, today);
  const page = sorted.slice(offset, offset + limit);
  return { rows: page, total: sorted.length };
}

/* ============================================================
   SẮP XẾP MẶC ĐỊNH THEO NGÀY CẦN NHÂN LỰC (Yêu cầu #5)
   ------------------------------------------------------------
   Mặc định KHÔNG phải createdAt và KHÔNG phải ngày kết thúc mùa vụ.
   Thứ tự nhóm (khớp expectedDateBucket ở planning-recruitment-core):
     0 = Quá hạn / Cần xử lý : expected_date < hôm nay, còn thiếu người,
                               yêu cầu chưa COMPLETED/CANCELLED
     1 = Sắp tới             : expected_date >= hôm nay
     2 = Chưa có ngày cần nhân lực
   Trong từng nhóm: expected_date GẦN NHẤT trước (NULLS LAST).
   Người dùng vẫn có thể đổi sang cột khác qua sortBy.
   ============================================================ */
/**
 * Whitelist cột sắp xếp — chỉ những cột `sortable` trong catalog mới được
 * dùng, tra ngược về đúng cột Drizzle. Nhờ vậy UI đọc catalog từ
 * /api/planning/column-config là có ngay danh sách cột sort hợp lệ, không cần
 * hardcode, mà API vẫn không nhận chuỗi tuỳ ý (chống SQL injection qua ORDER BY).
 */
const SORTABLE_DB_COLUMNS: Record<string, AnyPgColumn> = Object.fromEntries(
  SORTABLE_COLUMN_KEYS.filter((key) => key in recruitmentRequests).map((key) => [
    key,
    recruitmentRequests[key as keyof typeof recruitmentRequests] as AnyPgColumn,
  ]),
);

function buildOrderBy(filter: RecruitmentRequestFilter) {
  const dir = filter.sortDir === "desc" ? desc : asc;

  switch (filter.sortBy) {
    case "createdAt":
      return [dir(recruitmentRequests.createdAt)];
    case "expectedDate":
      return [
        sql`${recruitmentRequests.expectedDate} is null`,
        dir(recruitmentRequests.expectedDate),
        asc(recruitmentRequests.requestCode),
      ];
    default: {
      const col = filter.sortBy ? SORTABLE_DB_COLUMNS[filter.sortBy] : undefined;
      if (col) {
        // NULLS LAST cho mọi cột để dòng thiếu dữ liệu không chiếm đầu bảng.
        return [sql`${col} is null`, dir(col), asc(recruitmentRequests.requestCode)];
      }
      return [
        // Nhóm ưu tiên.
        sql`case
              when ${recruitmentRequests.expectedDate} is null then 2
              when ${recruitmentRequests.expectedDate} < CURRENT_DATE
                   and COALESCE(${recruitmentRequests.totalBalance}, 0) > 0
                   and ${recruitmentRequests.status} not in ('COMPLETED', 'CANCELLED') then 0
              else 1
            end`,
        // Trong nhóm: gần nhất trước; quá hạn lâu nhất lên trên cùng.
        sql`${recruitmentRequests.expectedDate} asc nulls last`,
        asc(recruitmentRequests.requestCode),
      ];
    }
  }
}

export async function getRecruitmentRequest(id: string): Promise<RecruitmentRequest | null> {
  const [row] = await db
    .select()
    .from(recruitmentRequests)
    .where(and(eq(recruitmentRequests.id, id), isNull(recruitmentRequests.deletedAt)));
  return row ?? null;
}

/**
 * Production Recovery audit (IDOR) — `scope` (từ getUserScope(), null = không giới hạn) BẮT BUỘC
 * truyền và áp dụng trực tiếp vào WHERE, giống mọi route đơn lẻ (GET/PATCH/DELETE by id) đã làm.
 * Trước đây route batch gọi getUserScope() nhưng KHÔNG truyền vào đây — 1 tài khoản bị giới hạn
 * Data Scope có thể batch cancel/status/delete request của phòng ban khác (chỉ cần biết id).
 * ids ngoài scope đơn giản không match WHERE — rowCount trả về phản ánh đúng số dòng đã áp dụng.
 */
export async function batchUpdateStatus(
  ids: string[],
  status: string,
  updatedBy: string,
  scope: string[] | null,
): Promise<number> {
  if (ids.length === 0) return 0;
  if (scope !== null && scope.length === 0) return 0;
  const result = await db
    .update(recruitmentRequests)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        inArray(recruitmentRequests.id, ids),
        isNull(recruitmentRequests.deletedAt),
        scope !== null ? inArray(recruitmentRequests.departmentId, scope) : undefined,
      ),
    );
  return result.rowCount ?? 0;
}

export async function softDeleteRecruitmentRequests(
  ids: string[],
  deletedBy: string,
  scope: string[] | null,
): Promise<number> {
  if (ids.length === 0) return 0;
  if (scope !== null && scope.length === 0) return 0;
  const result = await db
    .update(recruitmentRequests)
    .set({ deletedAt: new Date(), deletedBy, updatedAt: new Date() })
    .where(
      and(
        inArray(recruitmentRequests.id, ids),
        isNull(recruitmentRequests.deletedAt),
        scope !== null ? inArray(recruitmentRequests.departmentId, scope) : undefined,
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

/**
 * C2 (Mission C) — Recruited/Balance are now derived from the CANONICAL
 * allocation-aware engine (batchComputeRequestKpis), never the stale
 * persisted maleRecruited/femaleRecruited/maleBalance/femaleBalance/
 * totalBalance columns. maleRq/femaleRq stay an EXACT SQL SUM over every
 * matching row (independent review finding: these are user-entered targets,
 * not derived/stale, so they must never be truncated by the candidate
 * bound below) — same for status counts (exact SQL COUNT(*)). Only
 * Recruited/Balance — which require the canonical per-request KPI engine —
 * are bounded by MAX_KPI_CANDIDATES (no stored KPI cache table; Production
 * row counts for this table are modest — see Mission C audit). If that
 * bound is ever actually hit, Recruited/Balance become an approximation
 * over the newest MAX_KPI_CANDIDATES rows rather than a silent wrong exact
 * number — logged so it's visible in Production, never swallowed.
 */
export async function getRecruitmentStats(scope?: string[] | null): Promise<RecruitmentStats> {
  const conditions: any[] = [isNull(recruitmentRequests.deletedAt)];
  // Data Scope theo department_id (FK), không theo tên phòng ban dạng text.
  if (scope !== null && scope !== undefined && scope.length > 0) {
    conditions.push(inArray(recruitmentRequests.departmentId, scope));
  } else if (scope !== null && scope !== undefined && scope.length === 0) {
    return {
      totalRequests: 0, pending: 0, processing: 0, completed: 0, cancelled: 0,
      totalMaleRq: 0, totalFemaleRq: 0, totalMaleRecruited: 0, totalFemaleRecruited: 0,
      totalMaleBalance: 0, totalFemaleBalance: 0, totalBalance: 0,
    };
  }

  const where = conditions.length > 1 ? and(...conditions) : conditions[0];

  const [statusCounts, exactSums, candidates] = await Promise.all([
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
      })
      .from(recruitmentRequests)
      .where(where),
    db
      .select()
      .from(recruitmentRequests)
      .where(where)
      .orderBy(desc(recruitmentRequests.createdAt))
      .limit(MAX_KPI_CANDIDATES),
  ]);

  const statusMap = new Map(statusCounts.map((r) => [r.status, r.count]));
  const totalRequests = statusCounts.reduce((acc, r) => acc + r.count, 0);
  if (totalRequests > MAX_KPI_CANDIDATES) {
    console.warn(
      `[getRecruitmentStats] totalRequests (${totalRequests}) exceeds MAX_KPI_CANDIDATES (${MAX_KPI_CANDIDATES}) — Recruited/Balance sums are an approximation over the newest ${MAX_KPI_CANDIDATES} requests, not exact.`,
    );
  }

  const today = todayStr();
  const candidatesById = new Map(candidates.map((r) => [r.id, r]));
  const kpiByRequestId = await batchComputeRequestKpis(candidates, (r) => resolveDefaultAsOf(candidatesById.get(r.id)!, today));

  let totalMaleRecruited = 0;
  let totalFemaleRecruited = 0;
  let totalMaleBalance = 0;
  let totalFemaleBalance = 0;
  let totalBalance = 0;
  for (const r of candidates) {
    const kpi = kpiByRequestId.get(r.id);
    if (!kpi) continue;
    totalMaleRecruited += kpi.maleRecruited;
    totalFemaleRecruited += kpi.femaleRecruited;
    totalMaleBalance += kpi.maleBalance;
    totalFemaleBalance += kpi.femaleBalance;
    totalBalance += kpi.totalBalance;
  }

  return {
    totalRequests,
    pending: statusMap.get("PENDING") ?? 0,
    processing: statusMap.get("PROCESSING") ?? 0,
    completed: statusMap.get("COMPLETED") ?? 0,
    cancelled: statusMap.get("CANCELLED") ?? 0,
    totalMaleRq: exactSums[0]?.maleRq ?? 0,
    totalFemaleRq: exactSums[0]?.femaleRq ?? 0,
    totalMaleRecruited,
    totalFemaleRecruited,
    totalMaleBalance,
    totalFemaleBalance,
    totalBalance,
  };
}

/* ============================================================
   HIERARCHY MATCH — Location → Division → Department → Section → Group
   Khớp với cấu trúc Dalat Hasfarm
   ============================================================ */
/**
 * Chuẩn hoá text trước khi so khớp: trim whitespace (rất hay gặp khi copy-paste từ Excel) +
 * Unicode NFC (tiếng Việt import từ nguồn khác — PDF, tool khác — có thể ở dạng NFD/tổ hợp dấu
 * rời; nhìn giống hệt nhưng so `eq()` chuỗi byte-for-byte sẽ KHÔNG khớp, khiến department_id âm
 * thầm = null, mất Data Scope + loại khỏi mọi KPI theo phòng ban). Không đổi giá trị đã đúng NFC.
 */
function normalizeMatchText(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().normalize("NFC");
  return t || null;
}

export async function matchHierarchy(
  location?: string | null,
  division?: string | null,
  department?: string | null,
  section?: string | null,
  group?: string | null,
): Promise<{ deptId: string | null; matched: boolean }> {
  const loc = normalizeMatchText(location);
  const div = normalizeMatchText(division);
  const dept_ = normalizeMatchText(department);
  const sec = normalizeMatchText(section);
  const grp = normalizeMatchText(group);

  const conditions: any[] = [isNull(departments.deletedAt)];
  if (loc) conditions.push(eq(departments.location, loc));
  if (div) conditions.push(eq(departments.division, div));
  if (dept_) conditions.push(eq(departments.deptName, dept_));
  if (sec) conditions.push(eq(departments.section, sec));
  if (grp) conditions.push(eq(departments.groupName, grp));

  if (conditions.length <= 1) return { deptId: null, matched: false };

  const [dept] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(...conditions))
    .limit(1);

  return { deptId: dept?.id ?? null, matched: !!dept };
}