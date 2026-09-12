import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { departments, employmentSessions, workerProfiles } from "@/db/schema";
import { getUserScope } from "@/lib/auth";
import { isFemale, isMale, todayStr } from "@/lib/helpers";
import { countActiveDepartmentWorkforce } from "@/lib/recruitment-kpi";
import { searchOrganizationUnits } from "@/lib/organization-search";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";
import { intersectDepartmentFilter } from "../scope-helpers.ts";

/**
 * Domain: Organization hierarchy + current workforce headcount (audit
 * domains 1-2). departments.id is the REAL Data-Scope FK unit (getUserScope()
 * returns department UUIDs, not organization_units.id — see audit).
 *
 * Company-wide (no departmentId) ACTIVE headcount by gender has no existing
 * authoritative function (a confirmed audit gap) — this reuses the exact
 * canonical ACTIVE predicate (status='APPROVED' AND end_date IS NULL,
 * worker_profiles.deleted_at IS NULL) that countActiveDepartmentWorkforce
 * itself encodes, just without pinning to a single department.
 *
 * Entity resolution fix (Production bug — false "no department named X"):
 * `search_organization_units` is the canonical partial/abbreviated-name
 * resolver (src/lib/organization-search.ts), built on the SAME
 * organization_units table the Cây tổ chức admin UI reads — never a second,
 * AI-only directory. list_departments' own `search` filter is now powered
 * by the same resolver instead of an exact-string match against
 * departments.deptName (which could never contain a compound display name
 * like "Chrysanth Spray — Fast" — that string lives in organization_units,
 * composed from deptName + groupName at migration time).
 */

type ListDepartmentsArgs = { search?: string };

const list_departments: ToolDefinition<ListDepartmentsArgs, { departments: { id: string; name: string; activeWorkforce: number }[] }> = {
  name: "list_departments",
  description:
    "Liệt kê các bộ phận (phòng ban) mà người dùng hiện tại có quyền xem, kèm số lao động đang làm việc (ACTIVE) mỗi bộ phận. Dùng khi câu hỏi cần biết có những bộ phận nào hoặc so sánh nhân lực giữa các bộ phận. `search` hỗ trợ tên KHÔNG đầy đủ/viết tắt (khớp một phần) — không cần gõ đúng tên đầy đủ.",
  parameters: {
    type: "object",
    properties: { search: { type: "string", description: "Lọc theo tên bộ phận — hỗ trợ tên một phần/viết tắt (tuỳ chọn)." } },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return { search: typeof body.search === "string" ? body.search.trim().slice(0, 200) : undefined };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<{ departments: { id: string; name: string; activeWorkforce: number }[] }>> => {
    const scope = await getUserScope(ctx.session);
    const conditions = [eq(departments.isActive, true), isNull(departments.deletedAt)];
    if (scope !== null) {
      if (scope.length === 0) return { data: { departments: [] }, source: { domains: ["organization"], asOf: new Date().toISOString() } };
      conditions.push(inArray(departments.id, scope));
    }
    if (args.search) {
      const resolved = await searchOrganizationUnits({ query: args.search, scope, limit: 50 });
      const deptIds = resolved.candidates.map((c) => c.legacyDepartmentId).filter((id): id is string => id !== null);
      if (deptIds.length === 0) return { data: { departments: [] }, source: { domains: ["organization"], asOf: new Date().toISOString() } };
      conditions.push(inArray(departments.id, deptIds));
    }
    const rows = await db
      .select({ id: departments.id, name: departments.deptName })
      .from(departments)
      .where(and(...conditions))
      .limit(200);
    const withCounts = await Promise.all(
      rows.map(async (d) => ({ id: d.id, name: d.name, activeWorkforce: (await countActiveDepartmentWorkforce(db, d.id)).total })),
    );
    return { data: { departments: withCounts }, source: { domains: ["organization"], asOf: new Date().toISOString() } };
  },
};

type SearchOrgUnitsArgs = { query: string; includeInactive?: boolean; limit?: number };
type SearchOrgUnitsResult = {
  query: string;
  normalizedQuery: string;
  status: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";
  totalMatches: number;
  truncated: boolean;
  candidates: { id: string; name: string; unitType: string; isActive: boolean; breadcrumb: string; departmentId: string | null }[];
};

const search_organization_units: ToolDefinition<SearchOrgUnitsArgs, SearchOrgUnitsResult> = {
  name: "search_organization_units",
  description:
    "Tra cứu đơn vị tổ chức (bộ phận/phòng ban/nhóm ở bất kỳ tầng nào trong cây tổ chức — không chỉ 'Department') theo tên KHÔNG đầy đủ, viết tắt, hoặc không đúng thứ tự từ (ví dụ 'Fast', 'Middle 1', 'Spray Fast'). BẮT BUỘC gọi tool này TRƯỚC KHI kết luận một đơn vị/bộ phận không tồn tại — không bao giờ tự khẳng định 'không có bộ phận nào tên X' chỉ dựa vào suy đoán hoặc một tool khác không hỗ trợ tìm kiếm một phần. Kết quả trả về status: RESOLVED (đúng 1 đơn vị khớp mạnh — dùng luôn), AMBIGUOUS (nhiều đơn vị cùng khớp — PHẢI liệt kê các candidates và hỏi người dùng chọn, KHÔNG được tự chọn đại 1 cái hoặc coi là không tìm thấy), hoặc NOT_FOUND (thực sự không có đơn vị nào khớp trong phạm vi dữ liệu được phép — chỉ được nói 'không tìm thấy' khi tool trả về đúng trạng thái này). Nếu truncated=true, còn nhiều kết quả hơn totalMatches hiển thị — không khẳng định đã liệt kê hết, hãy đề nghị người dùng thu hẹp tên tìm kiếm.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Tên đơn vị cần tìm — có thể một phần/viết tắt/không đúng thứ tự." },
      includeInactive: { type: "boolean", description: "true để bao gồm cả đơn vị đã vô hiệu hoá (mặc định false — chỉ tìm đơn vị đang hoạt động)." },
      limit: { type: "number", description: "Số kết quả tối đa (mặc định 20, tối đa 50)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body.query !== "string" || !body.query.trim()) throw new ToolExecutionError("INVALID_ARGS", "query là bắt buộc.");
    return {
      query: body.query.trim().slice(0, 200),
      includeInactive: typeof body.includeInactive === "boolean" ? body.includeInactive : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<SearchOrgUnitsResult>> => {
    const scope = await getUserScope(ctx.session);
    const result = await searchOrganizationUnits({ query: args.query, scope, includeInactive: args.includeInactive, limit: args.limit });
    return {
      data: {
        query: result.query,
        normalizedQuery: result.normalizedQuery,
        status: result.status,
        totalMatches: result.totalMatches,
        truncated: result.truncated,
        candidates: result.candidates.map((c) => ({
          id: c.id,
          name: c.name,
          unitType: c.unitType,
          isActive: c.isActive,
          breadcrumb: c.breadcrumb.map((b) => b.name).join(" > "),
          departmentId: c.legacyDepartmentId,
        })),
      },
      source: { domains: ["organization"], asOf: new Date().toISOString() },
      truncated: result.truncated,
      totalCount: result.totalMatches,
    };
  },
};

type HeadcountArgs = { departmentId?: string };
type HeadcountResult = { male: number; female: number; unknownGender: number; total: number; scopeNote: string };

const get_current_headcount: ToolDefinition<HeadcountArgs, HeadcountResult> = {
  name: "get_current_headcount",
  description:
    "Lấy số lao động đang làm việc (ACTIVE) hiện tại theo giới tính — toàn công ty (trong phạm vi Data Scope) hoặc theo một bộ phận cụ thể. Dùng cho câu hỏi 'hiện có bao nhiêu lao động'. Trả về male + female + unknownGender = total LUÔN đúng (unknownGender = giới tính NULL/rỗng/không xác định trong hồ sơ — KHÔNG phải một giới tính thứ ba, chỉ là dữ liệu chưa phân loại được). Nếu unknownGender > 0 và người dùng hỏi ai là người đó, dùng tool find_current_workers với gender=\"UNKNOWN\" để tra cứu — KHÔNG suy đoán.",
  parameters: {
    type: "object",
    properties: { departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn) — bỏ trống để lấy toàn bộ phạm vi được phép." } },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return { departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<HeadcountResult>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    if (filter.departmentIds !== null && filter.departmentIds.length === 0) {
      return { data: { male: 0, female: 0, unknownGender: 0, total: 0, scopeNote: "Không có bộ phận nào trong phạm vi." }, source: { domains: ["workforce"], asOf: todayStr() } };
    }
    const conditions = [eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate), isNull(workerProfiles.deletedAt)];
    if (filter.departmentIds !== null) conditions.push(inArray(employmentSessions.deptId, filter.departmentIds));
    const rows = await db
      .select({ gender: workerProfiles.gender })
      .from(employmentSessions)
      .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
      .where(and(...conditions));
    let male = 0;
    let female = 0;
    for (const r of rows) {
      if (isMale(r.gender)) male += 1;
      else if (isFemale(r.gender)) female += 1;
    }
    return {
      data: {
        male,
        female,
        unknownGender: rows.length - male - female,
        total: rows.length,
        scopeNote: scope === null ? "Toàn công ty (không giới hạn Data Scope)." : `Giới hạn trong ${scope.length} bộ phận được cấp quyền.`,
      },
      source: { domains: ["workforce"], asOf: todayStr() },
    };
  },
};

const get_department_workforce: ToolDefinition<{ departmentId: string }, HeadcountResult> = {
  name: "get_department_workforce",
  description: "Lấy số lao động ACTIVE theo giới tính của MỘT bộ phận cụ thể (bắt buộc truyền departmentId).",
  parameters: {
    type: "object",
    properties: { departmentId: { type: "string", description: "UUID bộ phận." } },
    required: ["departmentId"],
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body.departmentId !== "string" || !body.departmentId.trim()) throw new ToolExecutionError("INVALID_ARGS", "departmentId là bắt buộc.");
    return { departmentId: body.departmentId.trim() };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<HeadcountResult>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const counts = await countActiveDepartmentWorkforce(db, args.departmentId);
    return { data: { ...counts, scopeNote: "Trong phạm vi được cấp quyền." }, source: { domains: ["workforce"], asOf: todayStr() } };
  },
};

export const organizationTools = [list_departments, search_organization_units, get_current_headcount, get_department_workforce];
