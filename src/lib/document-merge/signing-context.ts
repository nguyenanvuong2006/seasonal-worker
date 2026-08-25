/**
 * SIGNING CONTEXT (H3 — Computed Placeholder Engine V1).
 *
 * A typed, deterministic bag of "document creation" facts (signing date,
 * signing location, received date/by, ...) that COMPUTED mapping
 * expressions may reference by name (see formula-dsl.ts's
 * ALLOWED_IDENTIFIERS — this module's field names map 1:1 to those).
 *
 * DETERMINISTIC SNAPSHOT SEMANTICS (Phase 3) — the reason this is its own
 * module instead of `new Date()` sprinkled through the resolver:
 *   - At Preview, the context is supplied ONCE by the caller for that call.
 *   - At merge-job creation, the context is frozen ONCE into immutable job
 *     metadata (async-job.ts) — every record in that job (all 130, or
 *     however many) reads the SAME frozen context. A batch that starts at
 *     23:59 and finishes at 00:03 must never produce two different signing
 *     dates for records in the same job.
 *   - The worker NEVER calls `new Date()` to determine SigningDate — it only
 *     ever consumes the frozen context from job metadata (worker/src/index.ts).
 *
 * This module itself never reads the wall clock and never calls geolocation
 * (browser or otherwise) — `getTodayInBusinessTimezone()` below is the ONE
 * explicit, deliberately-isolated exception, meant to be called by UI/route
 * code exactly once to seed a DEFAULT before the operator confirms and the
 * context gets frozen (Phase 20) — it is never called from inside the
 * resolution/evaluation pipeline itself.
 */

import type { FormulaContextValues } from "./formula-dsl.ts";

/** Same business timezone convention as formatters.ts' DISPLAY_TIMEZONE / formula-dsl.ts. */
const BUSINESS_TIMEZONE = "Asia/Ho_Chi_Minh";

export interface SigningContext {
  /** Date-only "YYYY-MM-DD". The date the document is considered signed. */
  signingDate: string | null;
  signingLocation: string | null;
  /** Date-only "YYYY-MM-DD". */
  documentDate: string | null;
  /** Date-only "YYYY-MM-DD". */
  receivedDate: string | null;
  receivedBy: string | null;
  /** Optional captured-location metadata (Phase 21) — never mandatory, never captured during render. */
  signingLatitude: number | null;
  signingLongitude: number | null;
  /** ISO timestamp of when the coordinates were captured, if they were. */
  signingLocationCapturedAt: string | null;
}

export const EMPTY_SIGNING_CONTEXT: SigningContext = {
  signingDate: null,
  signingLocation: null,
  documentDate: null,
  receivedDate: null,
  receivedBy: null,
  signingLatitude: null,
  signingLongitude: null,
  signingLocationCapturedAt: null,
};

const MAX_TEXT_LENGTH = 255;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDateOnly(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || !DATE_ONLY_RE.test(value.trim())) {
    return { ok: false, error: `"${field}" phải là ngày hợp lệ theo định dạng YYYY-MM-DD.` };
  }
  return { ok: true, value: value.trim() };
}

function normalizeText(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: `"${field}" phải là chuỗi ký tự.` };
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: `"${field}" vượt quá ${MAX_TEXT_LENGTH} ký tự cho phép.` };
  }
  return { ok: true, value: trimmed || null };
}

function normalizeCoordinate(value: unknown, field: string, min: number, max: number): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value !== "number" && typeof value !== "string") {
    return { ok: false, error: `"${field}" phải là số.` };
  }
  if (!Number.isFinite(n) || n < min || n > max) {
    return { ok: false, error: `"${field}" không hợp lệ.` };
  }
  return { ok: true, value: n };
}

/**
 * Validate + normalize an arbitrary (request-body-shaped) object into a
 * SigningContext. Every field is optional — an absent field resolves to
 * null, which the formula DSL already treats as "not set" (coalesce/
 * required-field semantics apply downstream, not here).
 */
export function parseSigningContext(raw: unknown): { ok: true; context: SigningContext } | { ok: false; error: string } {
  const data = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const signingDate = normalizeDateOnly(data.signingDate, "Ngày ký");
  if (!signingDate.ok) return signingDate;
  const documentDate = normalizeDateOnly(data.documentDate, "Ngày tài liệu");
  if (!documentDate.ok) return documentDate;
  const receivedDate = normalizeDateOnly(data.receivedDate, "Ngày tiếp nhận");
  if (!receivedDate.ok) return receivedDate;

  const signingLocation = normalizeText(data.signingLocation, "Địa điểm ký");
  if (!signingLocation.ok) return signingLocation;
  const receivedBy = normalizeText(data.receivedBy, "Người tiếp nhận");
  if (!receivedBy.ok) return receivedBy;

  const signingLatitude = normalizeCoordinate(data.signingLatitude, "Vĩ độ", -90, 90);
  if (!signingLatitude.ok) return signingLatitude;
  const signingLongitude = normalizeCoordinate(data.signingLongitude, "Kinh độ", -180, 180);
  if (!signingLongitude.ok) return signingLongitude;

  let signingLocationCapturedAt: string | null = null;
  if (data.signingLocationCapturedAt !== null && data.signingLocationCapturedAt !== undefined && data.signingLocationCapturedAt !== "") {
    if (typeof data.signingLocationCapturedAt !== "string" || Number.isNaN(new Date(data.signingLocationCapturedAt).getTime())) {
      return { ok: false, error: `"Thời điểm lấy vị trí" không hợp lệ.` };
    }
    signingLocationCapturedAt = data.signingLocationCapturedAt;
  }

  return {
    ok: true,
    context: {
      signingDate: signingDate.value,
      signingLocation: signingLocation.value,
      documentDate: documentDate.value,
      receivedDate: receivedDate.value,
      receivedBy: receivedBy.value,
      signingLatitude: signingLatitude.value,
      signingLongitude: signingLongitude.value,
      signingLocationCapturedAt,
    },
  };
}

/** Map the typed context onto the exact identifier keys formula-dsl.ts whitelists. */
export function toFormulaContextValues(context: SigningContext): FormulaContextValues {
  return {
    SigningDate: context.signingDate,
    SigningLocation: context.signingLocation,
    DocumentDate: context.documentDate,
    ReceivedDate: context.receivedDate,
    ReceivedBy: context.receivedBy,
    SigningLatitude: context.signingLatitude === null ? null : String(context.signingLatitude),
    SigningLongitude: context.signingLongitude === null ? null : String(context.signingLongitude),
    SigningLocationCapturedAt: context.signingLocationCapturedAt,
  };
}

/**
 * Serialize for freezing into merge_jobs.metadata / an audit-safe log. Plain
 * data only — never a secret, never more PII than a signing location/name
 * the operator already typed.
 */
export function toJsonSigningContext(context: SigningContext): Record<string, string | number | null> {
  return { ...context };
}

/**
 * Today's calendar date in the application's business timezone (Phase 20:
 * "If operator wants current date: UI sets default SigningDate to today's
 * local date BEFORE job creation"). Deliberately the ONLY wall-clock read in
 * this module — call it once, explicitly, at the moment a UI/route wants to
 * SEED a default. Never call this from inside evaluateFormula/resolveFormula
 * or from the worker's render path — those must only ever consume an
 * already-frozen context.
 */
export function getTodayInBusinessTimezone(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
