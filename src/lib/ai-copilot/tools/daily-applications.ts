import "server-only";
import { and, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications } from "@/db/schema";
import { getUserScope } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";
import { intersectDepartmentFilter } from "../scope-helpers.ts";

/**
 * Domain 6/12: Daily Applications (= candidate applications, confirmed by
 * audit as the SAME table, not a separate pipeline). No exported "count by
 * status" aggregate exists at the lib level (confirmed gap) — a thin,
 * scoped GROUP BY, following the raw-SQL/date-range pattern already used in
 * analytics.ts for this exact table.
 */

type SummaryArgs = { from?: string; to?: string; departmentId?: string };
type SummaryResult = { totalApplications: number; byStatus: Record<string, number>; from: string; to: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const get_daily_applications_summary: ToolDefinition<SummaryArgs, SummaryResult> = {
  name: "get_daily_applications_summary",
  description: "Tổng hợp số đơn ứng tuyển (Daily Application) theo trạng thái, trong một khoảng ngày đăng ký (regDate) và phạm vi Data Scope. Mặc định là hôm nay nếu không truyền from/to.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Ngày bắt đầu YYYY-MM-DD (mặc định hôm nay)." },
      to: { type: "string", description: "Ngày kết thúc YYYY-MM-DD (mặc định = from)." },
      departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." },
    },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    const from = typeof body.from === "string" && DATE_RE.test(body.from) ? body.from : undefined;
    const to = typeof body.to === "string" && DATE_RE.test(body.to) ? body.to : undefined;
    return { from, to, departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<SummaryResult>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const from = args.from ?? todayStr();
    const to = args.to ?? from;
    if (to < from) throw new ToolExecutionError("INVALID_ARGS", "to phải bằng hoặc sau from.");
    if (filter.departmentIds !== null && filter.departmentIds.length === 0) {
      return { data: { totalApplications: 0, byStatus: {}, from, to }, source: { domains: ["daily_applications"], asOf: todayStr() } };
    }
    const conditions = [gte(dailyApplications.regDate, from), lte(dailyApplications.regDate, to)];
    if (filter.departmentIds !== null) conditions.push(inArray(dailyApplications.deptId, filter.departmentIds));
    const rows = await db
      .select({ status: dailyApplications.status, count: sql<number>`count(*)` })
      .from(dailyApplications)
      .where(and(...conditions))
      .groupBy(dailyApplications.status);
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byStatus[r.status] = r.count;
      total += r.count;
    }
    return { data: { totalApplications: total, byStatus, from, to }, source: { domains: ["daily_applications"], asOf: todayStr() } };
  },
};

export const dailyApplicationTools = [get_daily_applications_summary];
