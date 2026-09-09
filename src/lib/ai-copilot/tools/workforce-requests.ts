import "server-only";
import { getUserScope } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { getRequestDashboard, listWorkforceRequests } from "@/lib/workforce-request";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";
import { capLimit, intersectDepartmentFilter } from "../scope-helpers.ts";

/**
 * Domain 10: Workforce Requests — the KPI-augmented view of recruitment_requests.
 * Reuses listWorkforceRequests/getRequestDashboard (src/lib/workforce-request.ts),
 * the most mature "as of" point-in-time query surface in the codebase per the
 * audit — never reimplemented here.
 */

const MAX_ROWS = 20;

type WorkforceRequestDto = {
  id: string;
  requestCode: string;
  department: string | null;
  status: string;
  expectedDate: string | null;
  kpi: { maleRequest: number; femaleRequest: number; totalRequest: number; maleCurrent: number; femaleCurrent: number; totalCurrent: number; maleBalance: number; femaleBalance: number; totalBalance: number; fillRatePercent: number };
};

type ListArgs = { status?: string; departmentId?: string; search?: string; asOf?: string; limit?: number };

const get_workforce_requests: ToolDefinition<ListArgs, { requests: WorkforceRequestDto[] }> = {
  name: "get_workforce_requests",
  description: "Tra cứu Workforce Request (yêu cầu tuyển dụng kèm KPI Balance/Fill rate) theo trạng thái/bộ phận/mốc thời gian (asOf, mặc định hôm nay), trong phạm vi Data Scope. Trả về tối đa 20 dòng.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", description: "PENDING | PROCESSING | COMPLETED | CANCELLED | EXPIRED" },
      departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." },
      search: { type: "string", description: "Từ khoá tìm theo mã yêu cầu/người yêu cầu/vị trí." },
      asOf: { type: "string", description: "Ngày YYYY-MM-DD để xem KPI tại thời điểm đó (mặc định hôm nay)." },
      limit: { type: "number", description: "Số dòng tối đa (mặc định 20, tối đa 20)." },
    },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return {
      status: typeof body.status === "string" ? body.status.trim().slice(0, 24) : undefined,
      departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined,
      search: typeof body.search === "string" ? body.search.trim().slice(0, 200) : undefined,
      asOf: typeof body.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf) ? body.asOf : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<{ requests: WorkforceRequestDto[] }>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    if (filter.departmentIds !== null && filter.departmentIds.length === 0) {
      return { data: { requests: [] }, source: { domains: ["workforce_request"], asOf: args.asOf ?? todayStr() } };
    }
    const limit = capLimit(args.limit, MAX_ROWS, MAX_ROWS);
    const rows = await listWorkforceRequests({
      scope,
      status: args.status,
      departmentId: args.departmentId,
      search: args.search,
      asOf: args.asOf,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const dtos: WorkforceRequestDto[] = page.map((r) => ({
      id: r.id,
      requestCode: r.requestCode,
      department: r.department,
      status: r.status,
      expectedDate: r.expectedDate,
      kpi: {
        maleRequest: r.kpi.maleRequest,
        femaleRequest: r.kpi.femaleRequest,
        totalRequest: r.kpi.totalRequest,
        maleCurrent: r.kpi.maleCurrent,
        femaleCurrent: r.kpi.femaleCurrent,
        totalCurrent: r.kpi.totalCurrent,
        maleBalance: r.kpi.maleBalance,
        femaleBalance: r.kpi.femaleBalance,
        totalBalance: r.kpi.totalBalance,
        fillRatePercent: r.kpi.fillRatePercent,
      },
    }));
    return {
      data: { requests: dtos },
      source: { domains: ["workforce_request"], asOf: args.asOf ?? todayStr() },
      truncated: rows.length > limit,
      totalCount: rows.length > limit ? undefined : rows.length,
    };
  },
};

type DashboardArgs = { asOf?: string };

const get_workforce_request_dashboard: ToolDefinition<DashboardArgs, unknown> = {
  name: "get_workforce_request_dashboard",
  description: "Lấy tổng hợp Dashboard Workforce Request (tổng Nam/Nữ cần tuyển, tổng hiện có, tổng thiếu) tại một thời điểm (asOf, mặc định hôm nay), trong phạm vi Data Scope.",
  parameters: {
    type: "object",
    properties: { asOf: { type: "string", description: "Ngày YYYY-MM-DD (mặc định hôm nay)." } },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return { asOf: typeof body.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf) ? body.asOf : undefined };
  },
  execute: async (ctx: ToolContext, args) => {
    const scope = await getUserScope(ctx.session);
    const dashboard = await getRequestDashboard(scope, args.asOf ?? todayStr());
    return {
      data: { summary: dashboard.summary, source: dashboard.source, asOfDate: dashboard.asOfDate, requestCount: dashboard.rows.length },
      source: { domains: ["workforce_request"], asOf: dashboard.asOfDate },
    };
  },
};

export const workforceRequestTools = [get_workforce_requests, get_workforce_request_dashboard];
