import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mealCutoffSettings, mealExclusions } from "@/db/schema";
import { toVNTimeStr } from "@/lib/helpers";

/**
 * MISSION E — MEAL CUTOFF (sections 15-18). Configurable singleton setting
 * (mirrors the existing `branding_settings` fixed-id-row pattern) plus a
 * per-(dailyApplication, date) exclusion marker. This module NEVER changes
 * the canonical Báo cơm eligibility rule (đã nhập DW + có Mã số công nhật,
 * IT Code irrelevant — src/lib/daily-intake-workflow.ts#isEligibleForMealExport)
 * — it only lets meal-list.ts EXCLUDE rows that rule would otherwise
 * include, for a worker who became NO_SHOW/DECLINED_AT_START/
 * STARTED_THEN_LEFT before the cutoff on that specific business date.
 */

const DEFAULT_CUTOFF_TIME = "10:00";

export type MealCutoffSettings = { cutoffTime: string; updatedAt: Date | null; updatedBy: string | null };

export async function getMealCutoffSettings(): Promise<MealCutoffSettings> {
  const [row] = await db.select().from(mealCutoffSettings).where(eq(mealCutoffSettings.id, "default")).limit(1);
  if (!row) return { cutoffTime: DEFAULT_CUTOFF_TIME, updatedAt: null, updatedBy: null };
  return { cutoffTime: row.cutoffTime, updatedAt: row.updatedAt, updatedBy: row.updatedBy ?? null };
}

export async function updateMealCutoffTime(cutoffTime: string, updatedBy: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoffTime)) {
    return { ok: false, error: "Giờ chốt không hợp lệ (định dạng HH:MM, 00:00–23:59)." };
  }
  await db
    .insert(mealCutoffSettings)
    .values({ id: "default", cutoffTime, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({ target: mealCutoffSettings.id, set: { cutoffTime, updatedBy, updatedAt: new Date() } });
  return { ok: true };
}

/** Pure comparison — "HH:MM" strings compare correctly with `>=` since both are zero-padded. */
export function isPastCutoff(cutoffTime: string, now: Date = new Date()): boolean {
  return toVNTimeStr(now) >= cutoffTime;
}

export type MealExclusionReason = "NO_SHOW" | "DECLINED_AT_START" | "STARTED_THEN_LEFT" | "MANUAL_CORRECTION";
export type MealCutoffOutcome = "CANCELLED_BEFORE_CUTOFF" | "REPORTED_AFTER_MEAL_CUTOFF";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ExcludeFromMealInput = {
  dailyApplicationId: string;
  excludeDate: string;
  reason: MealExclusionReason;
  excludedBy: string;
  sameDayEventId?: string | null;
  now?: Date;
};

export type ExcludeFromMealResult = { outcome: MealCutoffOutcome };

/**
 * Decides + records the exact meal effect of a same-day event (section
 * 16-17): before cutoff -> actually exclude from today's list
 * (CANCELLED_BEFORE_CUTOFF); at/after cutoff -> Employment/lifecycle still
 * proceeds but this NEVER pretends the meal was cancelled
 * (REPORTED_AFTER_MEAL_CUTOFF) — dashboards can distinguish the two to
 * measure food waste. Idempotent via the (dailyApplicationId, excludeDate)
 * unique index — a duplicate report for the same day is a safe no-op.
 */
export async function excludeFromMeal(input: ExcludeFromMealInput, executor: Executor = db): Promise<ExcludeFromMealResult> {
  const settings = await getMealCutoffSettings();
  const now = input.now ?? new Date();
  const outcome: MealCutoffOutcome = isPastCutoff(settings.cutoffTime, now) ? "REPORTED_AFTER_MEAL_CUTOFF" : "CANCELLED_BEFORE_CUTOFF";

  if (outcome === "CANCELLED_BEFORE_CUTOFF") {
    await executor
      .insert(mealExclusions)
      .values({
        dailyApplicationId: input.dailyApplicationId,
        excludeDate: input.excludeDate,
        reason: input.reason,
        excludedBy: input.excludedBy,
        sameDayEventId: input.sameDayEventId ?? null,
      })
      .onConflictDoNothing();
  }

  return { outcome };
}
