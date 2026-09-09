/**
 * AI COPILOT — canonical time-range resolver (Phase 2 "AI Analyst").
 * Pure (no "server-only", no DB) — same TZ convention already established
 * by helpers.ts:todayStr() (Asia/Ho_Chi_Minh) and the same UTC-anchored
 * date-string arithmetic already used by analytics-core.ts (addDays/
 * isValidDateStr/rangeDays, reused here rather than duplicated).
 *
 * "Do not rely on the LLM alone for date arithmetic" (mission requirement):
 * the model's ONLY decision is WHICH canonical keyword matches the user's
 * phrase (e.g. "tháng trước" -> "last_month") — that is intent
 * classification, not arithmetic. Every actual date computation below is
 * deterministic and unit-tested; the resolved {from,to} always goes into
 * the tool's ToolSource metadata so the UI can show the exact window used.
 */
import { addDays, isValidDateStr, rangeDays } from "../analytics-core.ts";

export const TIME_PERIOD_KEYWORDS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "last_7_days",
  "last_30_days",
  "last_90_days",
] as const;

export type TimePeriodKeyword = (typeof TIME_PERIOD_KEYWORDS)[number];

export type ResolvedPeriod = { from: string; to: string; label: string };

export type TimeExpressionInput = {
  /** Canonical keyword — the ONLY thing the model chooses; see TIME_PERIOD_KEYWORDS. */
  period?: string;
  /** Explicit calendar year, e.g. 2025 — for "năm 2025". Takes priority over `period` when set. */
  year?: number;
  /** Explicit range (both required together) — for arbitrary "from X to Y" questions. Takes priority over `period`/`year`. */
  from?: string;
  to?: string;
  /** "cùng kỳ năm trước" — resolve the comparison period as the same window one calendar year earlier. */
  compareToSamePeriodLastYear?: boolean;
};

export type TimeResolveResult =
  | { ok: true; period: ResolvedPeriod; comparisonPeriod: ResolvedPeriod | null }
  | { ok: false; error: string };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toDateStr(year: number, month1to12: number, day: number): string {
  return `${year}-${pad2(month1to12)}-${pad2(day)}`;
}

function parseDateStr(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { year: y, month: m, day: d };
}

/** Day of week, Monday=0..Sunday=6 (Vietnamese week convention — week starts Monday). */
function mondayIndex(dateStr: string): number {
  const jsDay = new Date(dateStr + "T00:00:00Z").getUTCDay(); // Sun=0..Sat=6
  return (jsDay + 6) % 7;
}

function lastDayOfMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function weekRange(anchor: string): { from: string; to: string } {
  const from = addDays(anchor, -mondayIndex(anchor));
  return { from, to: addDays(from, 6) };
}

export function monthRange(anchor: string): { from: string; to: string } {
  const { year, month } = parseDateStr(anchor);
  return { from: toDateStr(year, month, 1), to: toDateStr(year, month, lastDayOfMonth(year, month)) };
}

export function quarterRange(anchor: string): { from: string; to: string } {
  const { year, month } = parseDateStr(anchor);
  const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
  const quarterEndMonth = quarterStartMonth + 2;
  return { from: toDateStr(year, quarterStartMonth, 1), to: toDateStr(year, quarterEndMonth, lastDayOfMonth(year, quarterEndMonth)) };
}

export function yearRange(year: number): { from: string; to: string } {
  return { from: toDateStr(year, 1, 1), to: toDateStr(year, 12, 31) };
}

/** "cùng kỳ năm trước" — same calendar window one year earlier. Feb 29 clamps to Feb 28 in a non-leap target year. */
export function samePeriodLastYear(from: string, to: string): { from: string; to: string } {
  const shiftYear = (dateStr: string): string => {
    const { year, month, day } = parseDateStr(dateStr);
    const targetYear = year - 1;
    const clampedDay = month === 2 && day === 29 && !isLeapYear(targetYear) ? 28 : day;
    return toDateStr(targetYear, month, clampedDay);
  };
  return { from: shiftYear(from), to: shiftYear(to) };
}

function labelFor(period: TimePeriodKeyword | "year" | "range", range: { from: string; to: string }, extra?: string): string {
  const labels: Record<string, string> = {
    today: "Hôm nay",
    yesterday: "Hôm qua",
    this_week: "Tuần này",
    last_week: "Tuần trước",
    this_month: "Tháng này",
    last_month: "Tháng trước",
    this_quarter: "Quý này",
    last_quarter: "Quý trước",
    this_year: "Năm nay",
    last_year: "Năm trước",
    last_7_days: "7 ngày qua",
    last_30_days: "30 ngày qua",
    last_90_days: "90 ngày qua",
    year: extra ? `Năm ${extra}` : "Năm",
    range: `${range.from} → ${range.to}`,
  };
  return labels[period] ?? `${range.from} → ${range.to}`;
}

/**
 * Resolve a time expression to concrete {from,to} dates, deterministically.
 * `today` should always be helpers.ts:todayStr() in production — accepted as
 * a parameter (not called internally) so tests are deterministic and don't
 * depend on wall-clock time.
 */
export function resolveTimeExpression(input: TimeExpressionInput, today: string): TimeResolveResult {
  if (!isValidDateStr(today)) return { ok: false, error: "invalid `today` anchor" };

  let range: { from: string; to: string };
  let label: string;

  if (input.from || input.to) {
    if (!input.from || !input.to) return { ok: false, error: "from và to phải có cả hai." };
    if (!isValidDateStr(input.from) || !isValidDateStr(input.to)) return { ok: false, error: "from/to phải có định dạng YYYY-MM-DD hợp lệ." };
    if (input.to < input.from) return { ok: false, error: "to phải bằng hoặc sau from." };
    if (rangeDays(input.from, input.to) > 3660) return { ok: false, error: "Khoảng thời gian quá dài (tối đa ~10 năm)." };
    range = { from: input.from, to: input.to };
    label = labelFor("range", range);
  } else if (input.year !== undefined) {
    if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) return { ok: false, error: "year không hợp lệ." };
    range = yearRange(input.year);
    label = labelFor("year", range, String(input.year));
  } else {
    const period = (input.period ?? "this_month") as TimePeriodKeyword;
    if (!TIME_PERIOD_KEYWORDS.includes(period)) {
      return { ok: false, error: `period không hợp lệ. Giá trị hợp lệ: ${TIME_PERIOD_KEYWORDS.join(", ")}.` };
    }
    switch (period) {
      case "today":
        range = { from: today, to: today };
        break;
      case "yesterday": {
        const y = addDays(today, -1);
        range = { from: y, to: y };
        break;
      }
      case "this_week":
        range = weekRange(today);
        break;
      case "last_week": {
        const thisWeek = weekRange(today);
        range = { from: addDays(thisWeek.from, -7), to: addDays(thisWeek.to, -7) };
        break;
      }
      case "this_month":
        range = monthRange(today);
        break;
      case "last_month": {
        const thisMonth = monthRange(today);
        range = monthRange(addDays(thisMonth.from, -1));
        break;
      }
      case "this_quarter":
        range = quarterRange(today);
        break;
      case "last_quarter": {
        const thisQuarter = quarterRange(today);
        range = quarterRange(addDays(thisQuarter.from, -1));
        break;
      }
      case "this_year":
        range = yearRange(parseDateStr(today).year);
        break;
      case "last_year":
        range = yearRange(parseDateStr(today).year - 1);
        break;
      case "last_7_days":
        range = { from: addDays(today, -6), to: today };
        break;
      case "last_30_days":
        range = { from: addDays(today, -29), to: today };
        break;
      case "last_90_days":
        range = { from: addDays(today, -89), to: today };
        break;
    }
    label = labelFor(period, range);
  }

  const comparisonPeriod = input.compareToSamePeriodLastYear
    ? { ...samePeriodLastYear(range.from, range.to), label: `Cùng kỳ năm trước (${samePeriodLastYear(range.from, range.to).from} → ${samePeriodLastYear(range.from, range.to).to})` }
    : null;

  return { ok: true, period: { ...range, label }, comparisonPeriod };
}
