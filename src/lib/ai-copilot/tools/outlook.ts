import "server-only";
import { todayStr } from "@/lib/helpers";
import { parseOutlookFilters } from "@/lib/workforce-intelligence/filters";
import {
  get_workforce_outlook as outlookFull,
  get_department_risk as outlookDeptRisk,
  get_demand_supply_gap as outlookGap,
  get_recruitment_velocity as outlookVelocity,
  get_expected_exits as outlookExits,
  get_pipeline_forecast as outlookPipeline,
} from "@/lib/workforce-intelligence/tools";
import type { OutlookFilters } from "@/lib/workforce-intelligence/types";
import type { ToolContext, ToolDefinition, JsonSchema } from "../types.ts";
import { ToolExecutionError } from "../types.ts";

/**
 * Domain 8/16 (forward-looking only — see audit): thin wrappers around the
 * ALREADY AI-tool-shaped src/lib/workforce-intelligence/tools.ts (9 functions
 * that each call getWorkforceIntelligence() once and project a sub-object).
 * This module only adds JSON-schema args parsing/validation on top — it does
 * not touch the underlying forecast logic. Forward-only (from >= today,
 * max 90 days) is enforced by parseOutlookFilters itself, unchanged.
 */

type RawArgs = { from?: unknown; to?: unknown; departmentId?: unknown };

function parseArgsToOutlook(raw: unknown): OutlookFilters {
  const body = (raw ?? {}) as RawArgs;
  const params = new URLSearchParams();
  if (typeof body.from === "string") params.set("from", body.from);
  if (typeof body.to === "string") params.set("to", body.to);
  if (typeof body.departmentId === "string") params.set("departmentId", body.departmentId);
  const parsed = parseOutlookFilters(params, todayStr());
  if (!parsed.ok) throw new ToolExecutionError("INVALID_ARGS", parsed.error);
  return parsed.filters;
}

const OUTLOOK_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    from: { type: "string", description: "Ngày bắt đầu YYYY-MM-DD, mặc định hôm nay. KHÔNG được ở quá khứ." },
    to: { type: "string", description: "Ngày kết thúc YYYY-MM-DD, mặc định from+29 ngày, tối đa 90 ngày sau from." },
    departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." },
  },
  additionalProperties: false,
};

function outOfScopeGuard(outOfScope: boolean) {
  if (outOfScope) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
}

const get_workforce_outlook: ToolDefinition<OutlookFilters, unknown> = {
  name: "get_workforce_outlook",
  description: "Dự báo tổng hợp nhân lực (nhu cầu, nguồn cung, khoảng trống, rủi ro) cho một khoảng thời gian SẮP TỚI (không phải quá khứ), tối đa 90 ngày. Dùng cho câu hỏi về dự báo/kế hoạch tương lai.",
  parameters: OUTLOOK_SCHEMA,
  parseArgs: parseArgsToOutlook,
  execute: async (ctx: ToolContext, args) => {
    const data = await outlookFull(ctx.session, args);
    outOfScopeGuard(data.outOfScope);
    return { data, source: { domains: ["planning", "workforce"], asOf: data.asOfDate } };
  },
};

const get_department_risk: ToolDefinition<OutlookFilters & { departmentId: string }, unknown> = {
  name: "get_department_risk",
  description: "Đánh giá mức rủi ro thiếu hụt nhân lực SẮP TỚI của MỘT bộ phận cụ thể (bắt buộc departmentId).",
  parameters: {
    type: "object",
    properties: { ...OUTLOOK_SCHEMA.properties, departmentId: { type: "string", description: "UUID bộ phận (bắt buộc)." } },
    required: ["departmentId"],
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const filters = parseArgsToOutlook(raw);
    if (!filters.departmentId) throw new ToolExecutionError("INVALID_ARGS", "departmentId là bắt buộc.");
    return { ...filters, departmentId: filters.departmentId };
  },
  execute: async (ctx: ToolContext, args) => {
    const risk = await outlookDeptRisk(ctx.session, args);
    return { data: risk, source: { domains: ["planning", "workforce"], asOf: todayStr() } };
  },
};

const get_demand_supply_gap: ToolDefinition<OutlookFilters, unknown> = {
  name: "get_demand_supply_gap",
  description: "Lấy khoảng trống Nhu cầu vs Nguồn cung nhân lực SẮP TỚI (demand/supply/gap) cho một khoảng thời gian và bộ phận (tuỳ chọn).",
  parameters: OUTLOOK_SCHEMA,
  parseArgs: parseArgsToOutlook,
  execute: async (ctx: ToolContext, args) => {
    const data = await outlookGap(ctx.session, args);
    return { data, source: { domains: ["planning", "workforce"], asOf: todayStr() } };
  },
};

const get_recruitment_velocity: ToolDefinition<OutlookFilters, unknown> = {
  name: "get_recruitment_velocity",
  description: "Lấy tốc độ tuyển dụng dự kiến và số đơn ứng tuyển cần thiết để đạt mục tiêu, cho một khoảng thời gian sắp tới.",
  parameters: OUTLOOK_SCHEMA,
  parseArgs: parseArgsToOutlook,
  execute: async (ctx: ToolContext, args) => {
    const data = await outlookVelocity(ctx.session, args);
    return { data, source: { domains: ["planning", "recruitment"], asOf: todayStr() } };
  },
};

const get_expected_exits: ToolDefinition<OutlookFilters, unknown> = {
  name: "get_expected_exits",
  description: "Lấy số lao động dự kiến sẽ nghỉ việc trong một khoảng thời gian sắp tới.",
  parameters: OUTLOOK_SCHEMA,
  parseArgs: parseArgsToOutlook,
  execute: async (ctx: ToolContext, args) => {
    const data = await outlookExits(ctx.session, args);
    return { data, source: { domains: ["workforce"], asOf: todayStr() } };
  },
};

const get_pipeline_forecast: ToolDefinition<OutlookFilters, unknown> = {
  name: "get_pipeline_forecast",
  description: "Lấy dự báo pipeline ứng viên (nếu có tích hợp ATS) cho một khoảng thời gian sắp tới.",
  parameters: OUTLOOK_SCHEMA,
  parseArgs: parseArgsToOutlook,
  execute: async (ctx: ToolContext, args) => {
    const data = await outlookPipeline(ctx.session, args);
    return { data, source: { domains: ["recruitment"], asOf: todayStr() } };
  },
};

export const outlookTools = [
  get_workforce_outlook,
  get_department_risk,
  get_demand_supply_gap,
  get_recruitment_velocity,
  get_expected_exits,
  get_pipeline_forecast,
];
