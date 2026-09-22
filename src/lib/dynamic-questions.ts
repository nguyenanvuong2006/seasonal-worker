import "server-only";
import { asc, eq, isNull, lte, and, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { formQuestions } from "@/db/schema";
import { todayStr } from "@/lib/helpers";

/**
 * Lấy danh sách câu hỏi động có hiệu lực tại một thời điểm nhất định.
 * - applyFrom <= targetDate (hoặc null)
 * - effectiveTo > targetDate (hoặc null)
 */
export async function getEffectiveQuestions(targetDateStr: string = todayStr()) {
  const rows = await db
    .select()
    .from(formQuestions)
    .where(
      and(
        or(isNull(formQuestions.applyFrom), lte(formQuestions.applyFrom, targetDateStr)),
        or(isNull(formQuestions.effectiveTo), sql`${formQuestions.effectiveTo} > ${targetDateStr}`)
      )
    )
    .orderBy(asc(formQuestions.sortOrder));

  // Fail-closed resolution: exactly zero or one effective version per logical fieldKey
  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    keyCounts.set(row.fieldKey, (keyCounts.get(row.fieldKey) || 0) + 1);
  }

  const validRows = [];
  for (const row of rows) {
    if (keyCounts.get(row.fieldKey)! > 1) {
      console.error(`[CRITICAL] QUESTION_VERSION_OVERLAP: Duplicate effective versions found for fieldKey '${row.fieldKey}' on date ${targetDateStr}. Failing closed by excluding this field.`);
      continue; // Exclude it completely
    }
    validRows.push(row);
  }

  return validRows;
}

export async function getActiveEffectiveQuestions(targetDateStr: string = todayStr()) {
  const allEffective = await getEffectiveQuestions(targetDateStr);
  return allEffective.filter((q) => q.isActive);
}

export async function getApplicantEffectiveQuestions(targetDateStr: string = todayStr()) {
  const allEffective = await getEffectiveQuestions(targetDateStr);
  return allEffective.filter((q) => q.isActive && q.visibleToApplicants);
}
