import "server-only";
import { getUserScope } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { computeRecruitmentKpis } from "@/lib/recruitment-kpi";
import { getRecruitmentRequest, getRecruitmentStats, listRecruitmentRequests } from "@/lib/recruitment-request";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";
import { capLimit } from "../scope-helpers.ts";

/**
 * Domain 9: Recruitment Requests. Reuses listRecruitmentRequests/
 * getRecruitmentStats (src/lib/recruitment-request.ts) and the canonical
 * Recruitment Balance formula computeRecruitmentKpis (src/lib/recruitment-kpi.ts)
 * — never reimplemented, per the audit's explicit "FORBIDDEN to reimplement" note.
 */

const MAX_ROWS = 20;

type RecruitmentRequestDto = {
  id: string;
  requestCode: string;
  department: string | null;
  position: string | null;
  status: string;
  requestedDate: string | null;
  expectedDate: string | null;
  maleRq: number;
  femaleRq: number;
  maleBalance: number;
  femaleBalance: number;
  totalBalance: number;
};

type ListArgs = { status?: string; departmentId?: string; search?: string; limit?: number };
type ListResult = { requests: RecruitmentRequestDto[] };

const get_recruitment_requests: ToolDefinition<ListArgs, ListResult> = {
  name: "get_recruitment_requests",
  description: "Tra cứu danh sách Yêu cầu tuyển dụng (Recruitment Request) theo trạng thái/bộ phận/từ khoá, trong phạm vi Data Scope. Trả về tối đa 20 dòng kèm tổng số thực tế — không dump toàn bộ danh sách lớn.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", description: "PENDING | PROCESSING | COMPLETED | CANCELLED | EXPIRED" },
      departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." },
      search: { type: "string", description: "Từ khoá tìm theo mã yêu cầu/người yêu cầu/vị trí." },
      limit: { type: "number", description: "Số dòng tối đa cần xem trước (mặc định 20, tối đa 20)." },
    },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return {
      status: typeof body.status === "string" ? body.status.trim().slice(0, 24) : undefined,
      departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined,
      search: typeof body.search === "string" ? body.search.trim().slice(0, 200) : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<ListResult>> => {
    const scope = await getUserScope(ctx.session);
    const limit = capLimit(args.limit, MAX_ROWS, MAX_ROWS);
    const { rows, total } = await listRecruitmentRequests(
      { scope, status: args.status, searchQuery: args.search },
      limit + 1,
      0,
    );
    // departmentId narrowing: listRecruitmentRequests filters by text `department`, not the
    // FK — apply the FK-based narrow ourselves so a caller-supplied departmentId can only
    // ever narrow WITHIN what listRecruitmentRequests already scoped, never widen it.
    const filtered = args.departmentId ? rows.filter((r) => r.departmentId === args.departmentId) : rows;
    const page = filtered.slice(0, limit);
    const dtos: RecruitmentRequestDto[] = page.map((r) => ({
      id: r.id,
      requestCode: r.requestCode,
      department: r.department,
      position: r.position,
      status: r.status,
      requestedDate: r.requestedDate,
      expectedDate: r.expectedDate,
      maleRq: r.maleRq,
      femaleRq: r.femaleRq,
      maleBalance: r.maleBalance,
      femaleBalance: r.femaleBalance,
      totalBalance: r.totalBalance,
    }));
    return {
      data: { requests: dtos },
      source: { domains: ["recruitment"], asOf: todayStr() },
      truncated: filtered.length > limit,
      totalCount: args.departmentId ? filtered.length : total,
    };
  },
};

const get_recruitment_stats: ToolDefinition<Record<string, never>, Awaited<ReturnType<typeof getRecruitmentStats>>> = {
  name: "get_recruitment_stats",
  description: "Lấy thống kê tổng hợp Yêu cầu tuyển dụng (số lượng theo trạng thái, tổng Nam/Nữ cần tuyển, tổng Balance còn thiếu) trong phạm vi Data Scope. Không nhận tham số.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  parseArgs: () => ({}),
  execute: async (ctx: ToolContext) => {
    const scope = await getUserScope(ctx.session);
    const stats = await getRecruitmentStats(scope);
    return { data: stats, source: { domains: ["recruitment"], asOf: todayStr() } };
  },
};

type KpiArgs = { requestId: string };

const get_recruitment_request_kpi: ToolDefinition<KpiArgs, unknown> = {
  name: "get_recruitment_request_kpi",
  description: "Lấy KPI chi tiết (Recruitment Balance vs Realtime Gap) của MỘT Yêu cầu tuyển dụng cụ thể theo requestId.",
  parameters: {
    type: "object",
    properties: { requestId: { type: "string", description: "UUID của Recruitment Request." } },
    required: ["requestId"],
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body.requestId !== "string" || !body.requestId.trim()) throw new ToolExecutionError("INVALID_ARGS", "requestId là bắt buộc.");
    return { requestId: body.requestId.trim() };
  },
  execute: async (ctx: ToolContext, args) => {
    const scope = await getUserScope(ctx.session);
    const request = await getRecruitmentRequest(args.requestId);
    if (!request) throw new ToolExecutionError("NOT_FOUND", "Không tìm thấy Yêu cầu tuyển dụng này.");
    if (scope !== null && (!request.departmentId || !scope.includes(request.departmentId))) {
      throw new ToolExecutionError("FORBIDDEN", "Yêu cầu tuyển dụng này nằm ngoài Data Scope của bạn.");
    }
    const kpi = await computeRecruitmentKpis(request.id);
    return { data: { requestCode: request.requestCode, kpi }, source: { domains: ["recruitment"], asOf: todayStr() } };
  },
};

export const recruitmentTools = [get_recruitment_requests, get_recruitment_stats, get_recruitment_request_kpi];
