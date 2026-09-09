import "server-only";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { departments, employmentSessions, workerProfiles } from "@/db/schema";
import { getUserScope } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { classifyGender, type GenderClassification } from "../gender-classification.ts";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";
import { capLimit, intersectDepartmentFilter } from "../scope-helpers.ts";

/**
 * AI COPILOT DRILL-DOWN GAP HARDENING (2026-09) — record-level drill-down for
 * the current ACTIVE workforce. Every aggregate tool (get_current_headcount,
 * get_fingerprint_compliance, ...) can report a discrepancy or a count but
 * cannot say WHO — this is the one general-purpose, authorized way to answer
 * "who" without a raw SQL escape hatch. Reuses the EXACT canonical ACTIVE
 * predicate (status='APPROVED' AND end_date IS NULL, worker_profiles.deleted_at
 * IS NULL) and the EXACT isMale/isFemale gender predicates already used by
 * get_current_headcount/countActiveDepartmentWorkforce — never a second
 * definition of "active" or "male/female" invented here.
 *
 * Gender classification is fetch-then-classify in JS (not pushed into SQL),
 * deliberately mirroring how get_current_headcount already works — isMale/
 * isFemale are free-text heuristics (worker_profiles.gender has no DB enum),
 * so reproducing them as SQL would risk a second, subtly different
 * definition. Rows are scanned in bounded batches (SCAN_CAP) ordered by a
 * stable key so a filtered drill-down (e.g. gender=UNKNOWN) can page through
 * a large ACTIVE workforce without ever pulling the whole table into memory
 * or handing thousands of raw rows to the model.
 *
 * PRIVACY: only the minimum fields needed to identify/locate a worker are
 * returned — workerId (operational identifier; worker_profiles has no
 * separate employee code), displayName (via normalizePersonName, same
 * redaction helper movements.ts uses), departmentId/departmentName, gender
 * CLASSIFICATION (not the raw stored string), and a fingerprintCodePresent
 * BOOLEAN (never the code value itself). CCCD/phone/address/DOB/bank/
 * document evidence are never selected — see privacy-audit.test.ts.
 */

const SCAN_CAP = 200;
const MAX_ROWS = 20;
const DEFAULT_ROWS = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GenderFilter = GenderClassification;

type FindWorkersArgs = {
  departmentId?: string;
  gender?: GenderFilter;
  fingerprintCodePresent?: boolean;
  limit?: number;
  cursor?: string;
};

type WorkerDto = {
  workerId: string;
  displayName: string;
  departmentId: string | null;
  departmentName: string | null;
  gender: GenderFilter;
  fingerprintCodePresent: boolean;
};

type FindWorkersResult = { workers: WorkerDto[]; nextCursor: string | null };

const find_current_workers: ToolDefinition<FindWorkersArgs, FindWorkersResult> = {
  name: "find_current_workers",
  description:
    `Tra cứu DANH SÁCH lao động ĐANG LÀM VIỆC (ACTIVE) cụ thể (drill-down) khi một câu hỏi tổng hợp cần biết CHÍNH XÁC LÀ AI — ví dụ số liệu get_current_headcount không khớp (unknownGender > 0) và người dùng hỏi "người đó là ai", hoặc get_fingerprint_compliance báo thiếu và người dùng hỏi "ai chưa có mã vân tay". Dùng CÙNG định nghĩa ACTIVE với get_current_headcount — không phải danh sách khác. Hỗ trợ lọc departmentId/gender (MALE|FEMALE|UNKNOWN)/fingerprintCodePresent, luôn giới hạn số dòng nhỏ (mặc định 10, tối đa 20) kèm cursor để lấy tiếp trang sau — KHÔNG BAO GIỜ trả về hàng nghìn dòng thô. Chỉ trả về tên/mã định danh/bộ phận/phân loại giới tính/có-hay-không mã vân tay — KHÔNG có CCCD/SĐT/địa chỉ/ngày sinh.`,
  parameters: {
    type: "object",
    properties: {
      departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." },
      gender: { type: "string", description: "MALE | FEMALE | UNKNOWN (tuỳ chọn) — UNKNOWN nghĩa là giới tính NULL/rỗng/không xác định được, không phải giới tính thứ ba." },
      fingerprintCodePresent: { type: "boolean", description: "true = chỉ lấy người ĐÃ có mã vân tay; false = chỉ lấy người CHƯA có (tuỳ chọn)." },
      limit: { type: "number", description: "Số dòng tối đa (mặc định 10, tối đa 20)." },
      cursor: { type: "string", description: "Giá trị nextCursor từ lần gọi trước, để lấy tiếp trang sau (tuỳ chọn)." },
    },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    const gender = typeof body.gender === "string" ? body.gender.trim().toUpperCase() : undefined;
    if (gender !== undefined && gender !== "MALE" && gender !== "FEMALE" && gender !== "UNKNOWN") {
      throw new ToolExecutionError("INVALID_ARGS", "gender phải là MALE, FEMALE hoặc UNKNOWN.");
    }
    const cursor = typeof body.cursor === "string" ? body.cursor.trim() : undefined;
    if (cursor && !UUID_RE.test(cursor)) throw new ToolExecutionError("INVALID_ARGS", "cursor không hợp lệ — chỉ dùng giá trị nextCursor từ lần gọi trước.");
    return {
      departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined,
      gender: gender as GenderFilter | undefined,
      fingerprintCodePresent: typeof body.fingerprintCodePresent === "boolean" ? body.fingerprintCodePresent : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
      cursor,
    };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<FindWorkersResult>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    if (filter.departmentIds !== null && filter.departmentIds.length === 0) {
      return { data: { workers: [], nextCursor: null }, source: { domains: ["workforce"], asOf: todayStr() } };
    }
    const limit = capLimit(args.limit, MAX_ROWS, DEFAULT_ROWS);
    const conditions = [eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate), isNull(workerProfiles.deletedAt)];
    if (filter.departmentIds !== null) conditions.push(inArray(employmentSessions.deptId, filter.departmentIds));
    if (args.cursor) conditions.push(gt(employmentSessions.id, args.cursor));

    const batch = await db
      .select({
        sessionId: employmentSessions.id,
        workerId: workerProfiles.id,
        fullName: workerProfiles.fullName,
        gender: workerProfiles.gender,
        fingerprintCode: workerProfiles.fingerprintCode,
        departmentId: employmentSessions.deptId,
        departmentName: departments.deptName,
      })
      .from(employmentSessions)
      .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
      .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
      .where(and(...conditions))
      .orderBy(asc(employmentSessions.id))
      .limit(SCAN_CAP);

    const matches: WorkerDto[] = [];
    let lastConsideredId: string | null = null;
    for (const row of batch) {
      lastConsideredId = row.sessionId;
      const gender = classifyGender(row.gender);
      const fingerprintCodePresent = !!row.fingerprintCode && row.fingerprintCode.trim() !== "";
      if (args.gender && gender !== args.gender) continue;
      if (args.fingerprintCodePresent !== undefined && fingerprintCodePresent !== args.fingerprintCodePresent) continue;
      matches.push({
        workerId: row.workerId,
        displayName: normalizePersonName(row.fullName) || "(chưa rõ tên)",
        departmentId: row.departmentId,
        departmentName: row.departmentName,
        gender,
        fingerprintCodePresent,
      });
      if (matches.length >= limit) break;
    }

    // Còn trang sau nếu: đã đủ `limit` kết quả TRONG batch (có thể còn khớp phía sau điểm dừng),
    // HOẶC batch quét được đúng SCAN_CAP dòng (chưa chắc đã quét hết phạm vi). Nếu batch ngắn hơn
    // SCAN_CAP, đã quét hết toàn bộ phạm vi được phép — không còn trang sau dù kết quả rỗng.
    const scannedFullCap = batch.length === SCAN_CAP;
    const hasMore = matches.length >= limit ? true : scannedFullCap;
    const nextCursor = hasMore ? lastConsideredId : null;

    return { data: { workers: matches, nextCursor }, source: { domains: ["workforce"], asOf: todayStr() }, truncated: hasMore, totalCount: undefined };
  },
};

export const workerTools = [find_current_workers];
