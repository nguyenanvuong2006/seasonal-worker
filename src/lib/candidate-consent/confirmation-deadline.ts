/**
 * ELECTRONIC CONFIRMATION — CONFIRMATION DEADLINE (2026-09-10 mission).
 *
 * Pure functions, no DB/fetch — safe to import from both server and client
 * (same convention as verification-display.ts). The deadline is always an
 * ABSOLUTE instant, computed once and frozen at issuance; nothing here ever
 * reads the browser clock as an authority.
 *
 * Asia/Ho_Chi_Minh (VN_TZ_OFFSET_MINUTES, helpers.ts) is a FIXED UTC+7
 * offset — Vietnam does not observe DST. "N calendar days later, same time
 * of day" is therefore mathematically IDENTICAL to adding N*24h to the
 * absolute instant; no calendar-aware timezone arithmetic is needed to get
 * this right, just plain millisecond addition.
 */

export const DEFAULT_CONFIRMATION_WINDOW_DAYS = 3;
export const CONFIRMATION_DEADLINE_DAY_PRESETS = [1, 2, 3, 5, 7] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_WINDOW_DAYS = 365;

/** issuedAt + N calendar days (Asia/Ho_Chi_Minh) — see module docblock for why this is plain ms math. */
export function computeDeadlineFromDays(issuedAt: Date, days: number): Date {
  return new Date(issuedAt.getTime() + days * MS_PER_DAY);
}

export type DeadlinePolicy = { kind: "DAYS"; days: number } | { kind: "ABSOLUTE"; at: Date };

export type ResolveDeadlineResult = { ok: true; deadlineAt: Date } | { ok: false; error: string };

/**
 * Resolves a confirmation-deadline policy (admin-chosen preset/custom days,
 * or an explicit absolute date/time) against the moment of issuance into
 * the ONE frozen absolute deadline to persist. `issuedAt` is always the
 * server's own `now` at the issue/batch-issue request — never client-
 * supplied. A custom absolute deadline must still be strictly after
 * issuedAt (a deadline in the past is not a deadline).
 */
export function resolveConfirmationDeadline(policy: DeadlinePolicy, issuedAt: Date): ResolveDeadlineResult {
  if (policy.kind === "DAYS") {
    if (!Number.isInteger(policy.days) || policy.days < 1 || policy.days > MAX_WINDOW_DAYS) {
      return { ok: false, error: `Số ngày không hợp lệ (phải từ 1 đến ${MAX_WINDOW_DAYS}).` };
    }
    return { ok: true, deadlineAt: computeDeadlineFromDays(issuedAt, policy.days) };
  }
  if (Number.isNaN(policy.at.getTime())) {
    return { ok: false, error: "Ngày giờ hết hạn không hợp lệ." };
  }
  if (policy.at.getTime() <= issuedAt.getTime()) {
    return { ok: false, error: "Hạn xác nhận phải sau thời điểm phát hành." };
  }
  return { ok: true, deadlineAt: policy.at };
}

/** Parses an issue/extend-deadline request body's deadline fields into a DeadlinePolicy — defaults to the 3-day window when nothing is specified. */
export function parseDeadlinePolicyFromBody(body: { deadlineDays?: unknown; deadlineAt?: unknown }): DeadlinePolicy {
  if (typeof body.deadlineAt === "string" && body.deadlineAt.trim().length > 0) {
    return { kind: "ABSOLUTE", at: new Date(body.deadlineAt) };
  }
  if (typeof body.deadlineDays === "number") {
    return { kind: "DAYS", days: body.deadlineDays };
  }
  return { kind: "DAYS", days: DEFAULT_CONFIRMATION_WINDOW_DAYS };
}

/**
 * "13/09/2026 17:00" — Asia/Ho_Chi_Minh, no seconds (matches the UX spec's
 * deadline display). Assembled from formatToParts() rather than trusting
 * Intl's part ORDER for a given locale — that order is an ICU/runtime
 * implementation detail (observed to vary between "date time" and
 * "time date" for the exact same options), so the exact DD/MM/YYYY HH:mm
 * layout is built explicitly instead of relying on it.
 */
export function formatDeadline(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

/** Informational-only "Còn N ngày" — the server (not this display string) is what actually blocks confirmation. */
export function formatRemainingTime(deadlineAt: Date | string | null | undefined, now: Date): string | null {
  if (!deadlineAt) return null;
  const deadline = typeof deadlineAt === "string" ? new Date(deadlineAt) : deadlineAt;
  if (Number.isNaN(deadline.getTime())) return null;
  const diffMs = deadline.getTime() - now.getTime();
  if (diffMs <= 0) return null;
  const days = Math.floor(diffMs / MS_PER_DAY);
  if (days >= 1) return `Còn ${days} ngày`;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours >= 1) return `Còn ${hours} giờ`;
  const minutes = Math.max(1, Math.floor(diffMs / (60 * 1000)));
  return `Còn ${minutes} phút`;
}
