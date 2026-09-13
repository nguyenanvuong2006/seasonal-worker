import "server-only";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions, workforceMovements } from "@/db/schema";

/**
 * WORKFORCE IDENTITY & IT CODE CONTRACT REVIEW (2026-09-13) — shared
 * NEW / RETURNING / TRANSFERRED classification for the IT Code queue
 * (page + Excel export). ONE service, reused by both consumers — never
 * duplicated logic (mission section 20).
 *
 * Derived STRICTLY from employment_sessions + workforce_movements history —
 * NEVER from IT Code/dw_data presence alone (mission section 13-14). IT Code
 * is operational payload; it is never used to infer whether someone is
 * new/returning/transferred.
 *
 * Semantics (see workforce-movements.ts for how each movement type mutates
 * state):
 *   - TRANSFER never ends/creates an employment_sessions row — it mutates
 *     deptId on the SAME active session in place. So a session is
 *     TRANSFERRED iff a workforce_movements row of type TRANSFER, for the
 *     same worker and referencing this exact employmentSessionId, has
 *     already been APPLIED (lifecycleAppliedAt IS NOT NULL). A
 *     future-dated/approved-but-not-yet-effective transfer
 *     (lifecycleAppliedAt still NULL) does NOT count — the worker is not
 *     "transferred" until the effective date actually arrives and the
 *     scheduler (or immediate apply path) sets lifecycleAppliedAt (mission
 *     section 31).
 *   - RESIGNATION always ends the session (status=ENDED); the person can
 *     only re-appear via a brand-new employment_sessions row from a new
 *     registration. So a session is RETURNING iff the same workerId already
 *     has an earlier employment_sessions row (any end reason) — TRANSFERRED
 *     is checked first and takes priority, since a transferred session is
 *     still the SAME engagement continuing, not a new one.
 *   - Otherwise (no earlier session for this worker, and not transferred):
 *     NEW — the person's first-ever employment_sessions row.
 */

export type WorkforceClassification = "NEW" | "RETURNING" | "TRANSFERRED";

type SessionRow = { id: string; workerId: string; dailyApplicationId: string | null; regDate: string; createdAt: Date };

/**
 * Classify a batch of daily_applications rows (identified by id) by their
 * linked employment_sessions engagement history. Rows with no matching
 * employment_sessions entry (not yet assigned/xếp việc) are omitted from the
 * result map — callers should treat a missing entry as "not yet
 * classifiable" rather than guessing NEW.
 */
export async function classifyWorkforceEngagements(
  dailyApplicationIds: string[],
): Promise<Map<string, WorkforceClassification>> {
  const result = new Map<string, WorkforceClassification>();
  const ids = [...new Set(dailyApplicationIds)].filter(Boolean);
  if (ids.length === 0) return result;

  const targetSessions = (await db
    .select({
      id: employmentSessions.id,
      workerId: employmentSessions.workerId,
      dailyApplicationId: employmentSessions.dailyApplicationId,
      regDate: employmentSessions.regDate,
      createdAt: employmentSessions.createdAt,
    })
    .from(employmentSessions)
    .where(inArray(employmentSessions.dailyApplicationId, ids))) as SessionRow[];

  if (targetSessions.length === 0) return result;

  const workerIds = [...new Set(targetSessions.map((s) => s.workerId))];

  const allSessions = (await db
    .select({
      id: employmentSessions.id,
      workerId: employmentSessions.workerId,
      dailyApplicationId: employmentSessions.dailyApplicationId,
      regDate: employmentSessions.regDate,
      createdAt: employmentSessions.createdAt,
    })
    .from(employmentSessions)
    .where(inArray(employmentSessions.workerId, workerIds))) as SessionRow[];

  const sessionsByWorker = new Map<string, SessionRow[]>();
  for (const s of allSessions) {
    const list = sessionsByWorker.get(s.workerId) ?? [];
    list.push(s);
    sessionsByWorker.set(s.workerId, list);
  }
  for (const list of sessionsByWorker.values()) {
    list.sort((a, b) => a.regDate.localeCompare(b.regDate) || a.createdAt.getTime() - b.createdAt.getTime());
  }

  const appliedTransfers = await db
    .select({ employmentSessionId: workforceMovements.employmentSessionId })
    .from(workforceMovements)
    .where(
      and(
        inArray(workforceMovements.workerId, workerIds),
        eq(workforceMovements.movementType, "TRANSFER"),
        isNotNull(workforceMovements.lifecycleAppliedAt),
      ),
    );
  const transferredSessionIds = new Set(appliedTransfers.map((r) => r.employmentSessionId).filter((id): id is string => !!id));

  for (const target of targetSessions) {
    if (!target.dailyApplicationId) continue;
    let classification: WorkforceClassification;
    if (transferredSessionIds.has(target.id)) {
      classification = "TRANSFERRED";
    } else {
      const workerSessions = sessionsByWorker.get(target.workerId) ?? [];
      const isFirst = workerSessions.length > 0 && workerSessions[0].id === target.id;
      classification = isFirst ? "NEW" : "RETURNING";
    }
    result.set(target.dailyApplicationId, classification);
  }

  return result;
}

export const CLASSIFICATION_LABELS: Record<WorkforceClassification, string> = {
  NEW: "Công nhật mới đăng ký",
  RETURNING: "Công nhật cũ quay lại",
  TRANSFERRED: "Công nhật cũ thuyên chuyển",
};
