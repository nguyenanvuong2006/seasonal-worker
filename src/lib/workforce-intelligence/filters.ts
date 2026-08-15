import { isValidDateStr } from "../analytics-core.ts";
import { addDateDays, daysBetween } from "./calculations.ts";
import type { OutlookFilters, ScenarioOverrides } from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_FORECAST_DAYS = 90;

export type ParseOutlookResult = { ok: true; filters: OutlookFilters } | { ok: false; error: string };

export function parseOutlookFilters(params: URLSearchParams, today: string): ParseOutlookResult {
  const from = params.get("from")?.trim() || today;
  const to = params.get("to")?.trim() || addDateDays(from, 29);
  const departmentId = params.get("departmentId")?.trim() || null;
  if (!isValidDateStr(from) || !isValidDateStr(to)) return { ok: false, error: "Ngày phải có định dạng YYYY-MM-DD hợp lệ." };
  if (from < today) return { ok: false, error: "Workforce forecast không tái dựng snapshot quá khứ; from phải từ hôm nay trở đi." };
  if (to < from) return { ok: false, error: "to phải bằng hoặc sau from." };
  if (daysBetween(from, to) + 1 > MAX_FORECAST_DAYS) return { ok: false, error: `Forecast tối đa ${MAX_FORECAST_DAYS} ngày.` };
  if (departmentId && !UUID_RE.test(departmentId)) return { ok: false, error: "departmentId không hợp lệ." };
  return { ok: true, filters: { from, to, departmentId } };
}

export function parseScenarioOverrides(value: unknown): { ok: true; overrides: ScenarioOverrides } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Scenario body không hợp lệ." };
  const body = value as Record<string, unknown>;
  if (typeof body.targetDepartmentId !== "string" || !UUID_RE.test(body.targetDepartmentId)) {
    return { ok: false, error: "targetDepartmentId hợp lệ là bắt buộc để scenario không phân bổ ngầm giữa các bộ phận." };
  }
  const numberField = (key: string, max: number): number | undefined => {
    if (body[key] === undefined) return undefined;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${key} phải từ 0 đến ${max}.`);
    return n;
  };
  try {
    const overrides: ScenarioOverrides = {
      targetDepartmentId: body.targetDepartmentId,
      additionalIncoming: numberField("additionalIncoming", 10_000),
      retainedExpectedExits: numberField("retainedExpectedExits", 10_000),
      returningWorkersActivated: numberField("returningWorkersActivated", 10_000),
      recruitmentVelocityMultiplier: numberField("recruitmentVelocityMultiplier", 3),
    };
    return { ok: true, overrides };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
