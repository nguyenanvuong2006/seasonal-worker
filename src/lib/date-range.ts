import { toVNDateStr, todayStr, VN_TZ_OFFSET_MINUTES } from "./helpers.ts";

/**
 * GLOBAL OPERATIONAL DATE RANGE STANDARDIZATION — canonical contract.
 * ------------------------------------------------------------------
 * Every operational list/report/export that filters "what happened between
 * these dates" (as opposed to a historical `asOf` snapshot, a movement's
 * `effectiveDate`, or any other record-specific date field) MUST use this
 * module — never hand-roll parsing/validation per route.
 *
 * `from`/`to` are the canonical query param names going forward. The legacy
 * single `date` param remains supported forever for backward compatibility
 * (bookmarks, existing internal callers): date=D is equivalent to
 * from=D&to=D. If both `date` and `from`/`to` are present, `from`/`to` wins.
 *
 * Default (no params at all) is `from=to=today` (Asia/Ho_Chi_Minh) — opening
 * a page behaves exactly like the old single-day screen, never a surprise
 * 30-day pull.
 */

export type DateRange = { from: string; to: string };

export type DateRangeErrorCode = "INVALID_DATE_RANGE" | "DATE_RANGE_TOO_LARGE";

export type DateRangeError = { code: DateRangeErrorCode; message: string };

export type DateRangeResult = { ok: true; range: DateRange } | { ok: false; error: DateRangeError };

/** No business need identified yet for anything shorter — annual reports are a real use case (mission section 25). */
export const DEFAULT_MAX_RANGE_DAYS = 366;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Real calendar-date check — rejects 2026-02-30, 2026-13-01, etc. (Date's own rollover would silently "fix" them). */
export function isValidBusinessDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Days between two YYYY-MM-DD strings (inclusive count = daysBetween + 1). Pure calendar-day arithmetic, never wall-clock. */
export function daysBetweenDates(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86400000);
}

/** Add N calendar days (N may be negative) to a YYYY-MM-DD string — pure calendar arithmetic, no timezone involved. */
export function addDaysToDateStr(value: string, n: number): string {
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Parses `from`/`to` (preferred) or legacy `date` from a URLSearchParams-like
 * object into a validated, canonical DateRange. Never throws — returns a
 * structured error instead, per mission section 26.
 */
export function parseOperationalDateRange(
  searchParams: { get(name: string): string | null },
  options: { maxRangeDays?: number } = {},
): DateRangeResult {
  const maxRangeDays = options.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS;
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const legacyDate = searchParams.get("date");

  let from: string;
  let to: string;
  if (fromParam || toParam) {
    // Canonical params present — win over legacy `date` even if both given (mission section 6).
    from = fromParam || toParam!;
    to = toParam || fromParam!;
  } else if (legacyDate) {
    from = legacyDate;
    to = legacyDate;
  } else {
    const today = todayStr();
    from = today;
    to = today;
  }

  if (!isValidBusinessDate(from) || !isValidBusinessDate(to)) {
    return { ok: false, error: { code: "INVALID_DATE_RANGE", message: "Ngày không hợp lệ." } };
  }
  if (from > to) {
    return { ok: false, error: { code: "INVALID_DATE_RANGE", message: "Từ ngày không được lớn hơn Đến ngày." } };
  }
  if (daysBetweenDates(from, to) + 1 > maxRangeDays) {
    return {
      ok: false,
      error: { code: "DATE_RANGE_TOO_LARGE", message: `Khoảng ngày vượt quá giới hạn cho phép (tối đa ${maxRangeDays} ngày).` },
    };
  }
  return { ok: true, range: { from, to } };
}

/** UTC instant corresponding to 00:00 Asia/Ho_Chi_Minh on the given calendar date — for building half-open TIMESTAMP bounds. */
export function vnStartOfDayUtc(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - VN_TZ_OFFSET_MINUTES * 60000);
}

/**
 * For TIMESTAMP (not DATE) columns: [from at VN start-of-day, day-after-to at
 * VN start-of-day) — a half-open interval, so `to` is inclusive of its whole
 * VN calendar day without any off-by-one risk (mission section 11).
 */
export function vnDateRangeToTimestampBounds(range: DateRange): { startUtc: Date; endUtcExclusive: Date } {
  return {
    startUtc: vnStartOfDayUtc(range.from),
    endUtcExclusive: vnStartOfDayUtc(addDaysToDateStr(range.to, 1)),
  };
}

/** "NGÀY dd/MM/yyyy" for a single day, "TỪ dd/MM/yyyy ĐẾN dd/MM/yyyy" for a range — matches the existing convention in api/export/route.ts. */
export function formatDateRangeLabel(range: DateRange, formatDate: (v: string) => string): string {
  return range.from === range.to ? `NGÀY ${formatDate(range.from)}` : `TỪ ${formatDate(range.from)} ĐẾN ${formatDate(range.to)}`;
}

/** Filename-safe range suffix, e.g. "2026-09-01_2026-09-13" or just "2026-09-13" when single-day — for export filenames (mission section 18). */
export function rangeFilenameSuffix(range: DateRange): string {
  return range.from === range.to ? range.from : `${range.from}_${range.to}`;
}

export type DateRangePreset = "TODAY" | "LAST_7_DAYS" | "THIS_MONTH";

/** Pure, VN-business-date-safe preset builders — never UTC calendar-day math (mission section 8). */
export function buildDateRangePreset(preset: DateRangePreset, now: Date = new Date()): DateRange {
  const today = toVNDateStr(now);
  switch (preset) {
    case "TODAY":
      return { from: today, to: today };
    case "LAST_7_DAYS":
      return { from: addDaysToDateStr(today, -6), to: today };
    case "THIS_MONTH": {
      const [y, m] = today.split("-");
      return { from: `${y}-${m}-01`, to: today };
    }
  }
}
