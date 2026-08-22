import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  departments,
  recruitmentRequests,
  type RecruitmentRequest,
  type NewRecruitmentRequest,
} from "@/db/schema";
import { SORTABLE_COLUMN_KEYS } from "@/lib/recruitment-request-columns";
import { scopeAllowsDepartment } from "@/lib/data-scope";
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
      const totalRequest = computeTotalRequest(toInt(canonical["Male Rq"]), toInt(canonical["Female Rq"]));
      const recruitedVsExpected = computeRecruitedVsExpected(
        toInt(canonical["Male Recruited"]),
        toInt(canonical["Female Recruited"]),
        totalRequest,
      );
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
                maleRecruited: toInt(canonical["Male Recruited"]),
                femaleRecruited: toInt(canonical["Female Recruited"]),
                maleQuit: toInt(canonical["Male Quit"]),
                femaleQuit: toInt(canonical["Female Quit"]),
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
                recruitedVsExpected,
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

            return { status: "UPDATED" as const, message: "Đã cập nhật" };
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
            maleRecruited: toInt(canonical["Male Recruited"]),
            femaleRecruited: toInt(canonical["Female Recruited"]),
            maleQuit: toInt(canonical["Male Quit"]),
            femaleQuit: toInt(canonical["Female Quit"]),
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
            recruitedVsExpected,
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

        return { status: "INSERTED" as const, message: "Đã thêm mới" };
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
  if (filter.fulfillment === "UNFILLED") conditions.push(sql`COALESCE(${recruitmentRequests.totalBalance}, 0) > 0`);
  if (filter.fulfillment === "FILLED") conditions.push(sql`COALESCE(${recruitmentRequests.totalBalance}, 0) = 0`);
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
      .orderBy(...buildOrderBy(filter))
      .limit(limit)
      .offset(offset),
  ]);

  return { rows, total: totalResult[0]?.count ?? 0 };
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