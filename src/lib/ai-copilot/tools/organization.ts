import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { departments, employmentSessions, workerProfiles } from "@/db/schema";
import { getUserScope } from "@/lib/auth";
import { isFemale, isMale, todayStr } from "@/lib/helpers";
import { countActiveDepartmentWorkforce } from "@/lib/recruitment-kpi";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";
import { intersectDepartmentFilter } from "../scope-helpers.ts";

/**
 * Domain: Organization hierarchy + current workforce headcount (audit
 * domains 1-2). departments.id is the REAL Data-Scope FK unit (getUserScope()
 * returns department UUIDs, not organization_units.id — see audit); the
 * arbitrary-depth org tree in organization-units.ts is deliberately NOT used
 * here since none of its exported functions accept a Data Scope.
 *
 * Company-wide (no departmentId) ACTIVE headcount by gender has no existing
 * authoritative function (a confirmed audit gap) — this reuses the exact
 * canonical ACTIVE predicate (status='APPROVED' AND end_date IS NULL,
 * worker_profiles.deleted_at IS NULL) that countActiveDepartmentWorkforce
 * itself encodes, just without pinning to a single department.
 */

type ListDepartmentsArgs = { search?: string };

const list_departments: ToolDefinition<ListDepartmentsArgs, { departments: { id: string; name: string; activeWorkforce: number }[] }> = {
  name: "list_departments",
  description: "Liệt kê các bộ phận (phòng ban) mà người dùng hiện tại có quyền xem, kèm số lao động đang làm việc (ACTIVE) mỗi bộ phận. Dùng khi câu hỏi cần biết có những bộ phận nào hoặc so sánh nhân lực giữa các bộ phận.",
  parameters: {
    type: "object",
    properties: { search: { type: "string", description: "Lọc theo tên bộ phận (tuỳ chọn)." } },
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
    if (args.search) conditions.push(eq(departments.deptName, args.search));
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

type HeadcountArgs = { departmentId?: string };
type HeadcountResult = { male: number; female: number; total: number; scopeNote: string };

const get_current_headcount: ToolDefinition<HeadcountArgs, HeadcountResult> = {
  name: "get_current_headcount",
  description: "Lấy số lao động đang làm việc (ACTIVE) hiện tại theo giới tính — toàn công ty (trong phạm vi Data Scope) hoặc theo một bộ phận cụ thể. Dùng cho câu hỏi 'hiện có bao nhiêu lao động'.",
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
      return { data: { male: 0, female: 0, total: 0, scopeNote: "Không có bộ phận nào trong phạm vi." }, source: { domains: ["workforce"], asOf: todayStr() } };
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
      data: { male, female, total: rows.length, scopeNote: scope === null ? "Toàn công ty (không giới hạn Data Scope)." : `Giới hạn trong ${scope.length} bộ phận được cấp quyền.` },
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

export const organizationTools = [list_departments, get_current_headcount, get_department_workforce];
