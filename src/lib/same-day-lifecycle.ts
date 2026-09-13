import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, employmentSessions, sameDayLifecycleEvents, workforceMovements } from "@/db/schema";
import { finalizeResignationEffect, type MovementForFinalize } from "@/lib/workforce-movements";
import { endActiveRequestAllocationsForWorker } from "@/lib/workforce-request";
import { recomputeStoredRecruitmentBalance } from "@/lib/recruitment-kpi";
import { releaseDwCode } from "@/lib/dw-code-pool";
import { releaseItCode } from "@/lib/it-code-assignment";
import { excludeFromMeal, type MealCutoffOutcome } from "@/lib/meal-cutoff";
import { todayStr } from "@/lib/helpers";
import { queueNotification } from "@/lib/notifications";
import { writeAudit, type Session } from "@/lib/auth";

/**
 * MISSION E — SAME-DAY NON-START / EARLY-LEAVE LIFECYCLE (sections 9-21, 43-46).
 * ------------------------------------------------------------------------
 * A worker registers -> gets arranged to a department (Employment Session
 * becomes ACTIVE at exactly that "xếp việc" step, per the audited
 * pipeline) -> then either never truly starts, or starts and leaves the
 * same day. This is ONE atomic orchestration across Employment/Request/
 * Planning/Meal/Codes/Notification — never a half-applied state (section
 * 45), and idempotent under double-submit (section 46, enforced by the
 * `same_day_event_session_uq` DB constraint AND an explicit pre-check).
 *
 * OUTCOME SEMANTICS (audited against the existing Quit/Recruited engine):
 *   - STARTED_THEN_LEFT creates a REAL workforce_movements resignation row
 *     and reuses the EXACT SAME finalizeResignationEffect() the normal
 *     resignation approval flow uses — canonical Quit-counting KPI
 *     naturally includes it, never a second counting path.
 *   - NO_SHOW / DECLINED_AT_START end the employment session directly
 *     WITHOUT creating a workforce_movements row — they must NOT count as
 *     Quit — but still end any ACTIVE request/planning allocation via the
 *     same endActiveRequestAllocationsForWorker() primitive Resignation
 *     uses (Current/Balance must not stay wrong just because this wasn't
 *     a "real" resignation).
 * Both branches release DW Code + IT Code (independent lifecycles) and
 * apply the exact meal-cutoff effect (see meal-cutoff.ts) — never claim a
 * meal was cancelled after the configured cutoff.
 */

export type SameDayOutcome = "NO_SHOW" | "DECLINED_AT_START" | "STARTED_THEN_LEFT";

const OUTCOME_LABELS: Record<SameDayOutcome, string> = {
  NO_SHOW: "Không đến nhận việc",
  DECLINED_AT_START: "Đến nhưng không nhận việc",
  STARTED_THEN_LEFT: "Bỏ về trong ca",
};

export function outcomeLabel(outcome: SameDayOutcome): string {
  return OUTCOME_LABELS[outcome];
}

export type ApplySameDayLifecycleEventInput = {
  workerId: string;
  outcome: SameDayOutcome;
  eventAt: Date;
  reason?: string | null;
  session: Session;
  /** Data Scope of the caller (mission section 12) — the worker's CURRENT dept must be within it. */
  scope: string[] | null;
};

export type ApplySameDayLifecycleEventResult =
  | {
      ok: true;
      alreadyApplied: boolean;
      eventId: string;
      mealAction: MealCutoffOutcome | "NOT_APPLICABLE";
      dwCodeReleased: boolean;
      itCodeReleased: boolean;
    }
  | { ok: false; error: "NO_ACTIVE_SESSION" | "OUT_OF_SCOPE" };

export async function applySameDayLifecycleEvent(input: ApplySameDayLifecycleEventInput): Promise<ApplySameDayLifecycleEventResult> {
  const result = await db.transaction(async (tx) => {
    const sessionColumns = {
      id: employmentSessions.id,
      workerId: employmentSessions.workerId,
      deptId: employmentSessions.deptId,
      dailyApplicationId: employmentSessions.dailyApplicationId,
      status: employmentSessions.status,
      endDate: employmentSessions.endDate,
    };

    // The TRUE active session (mission's own canonical predicate) — never
    // "most recent by regDate regardless of status", which could pick a
    // newer PENDING registration while an older session is still the real
    // ACTIVE one (at most one ACTIVE session can ever exist per worker,
    // enforced by employment_session_one_active_uq).
    const [activeSession] = await tx
      .select(sessionColumns)
      .from(employmentSessions)
      .where(and(eq(employmentSessions.workerId, input.workerId), eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate)))
      .limit(1)
      .for("update");

    if (!activeSession) {
      // No active session right now — either there never was one, OR a
      // prior call to THIS function already ended it (idempotent
      // double-submit, section 46). Distinguish by checking whether the
      // worker's most recent session already carries a same-day event.
      const [mostRecent] = await tx
        .select(sessionColumns)
        .from(employmentSessions)
        .where(eq(employmentSessions.workerId, input.workerId))
        .orderBy(desc(employmentSessions.regDate), desc(employmentSessions.createdAt))
        .limit(1);
      if (mostRecent) {
        const [existingEvent] = await tx
          .select()
          .from(sameDayLifecycleEvents)
          .where(eq(sameDayLifecycleEvents.employmentSessionId, mostRecent.id))
          .limit(1);
        if (existingEvent) {
          return {
            ok: true as const,
            alreadyApplied: true,
            eventId: existingEvent.id,
            mealAction: existingEvent.mealAction as MealCutoffOutcome | "NOT_APPLICABLE",
            dwCodeReleased: existingEvent.dwCodeReleased,
            itCodeReleased: existingEvent.itCodeReleased,
          };
        }
      }
      return { ok: false as const, error: "NO_ACTIVE_SESSION" as const };
    }

    const session = activeSession;
    if (session.deptId && input.scope !== null && !input.scope.includes(session.deptId)) {
      return { ok: false as const, error: "OUT_OF_SCOPE" as const };
    }
    if (!session.dailyApplicationId) return { ok: false as const, error: "NO_ACTIVE_SESSION" as const };

    const [app] = await tx
      .select({ id: dailyApplications.id, regDate: dailyApplications.regDate, dwId: dailyApplications.dwId })
      .from(dailyApplications)
      .where(eq(dailyApplications.id, session.dailyApplicationId))
      .limit(1);
    if (!app) return { ok: false as const, error: "NO_ACTIVE_SESSION" as const };

    const reasonText = input.reason?.trim() || `${outcomeLabel(input.outcome)} (báo cáo trong ngày)`;
    let movementId: string | null = null;
    let affectedRequestIds: string[] = [];
    let dwCodeReleased: boolean;
    let itCodeReleased: boolean;

    if (input.outcome === "STARTED_THEN_LEFT") {
      const [movement] = await tx
        .insert(workforceMovements)
        .values({
          movementType: "resignation",
          workerId: input.workerId,
          fromDeptId: session.deptId,
          effectiveDate: todayStr(),
          reason: reasonText,
          status: "INACTIVE",
          source: "SAME_DAY_REPORT",
          requestedBy: input.session.username,
          confirmedBy: input.session.username,
          confirmedAt: new Date(),
        })
        .returning();
      const movementForFinalize: MovementForFinalize = {
        id: movement.id,
        movementType: movement.movementType,
        workerId: movement.workerId,
        fromDeptId: movement.fromDeptId,
        toDeptId: movement.toDeptId,
        effectiveDate: movement.effectiveDate,
        status: movement.status,
        source: movement.source,
        note: movement.note,
        requestedBy: movement.requestedBy,
        lifecycleAppliedAt: movement.lifecycleAppliedAt,
        employmentSessionId: movement.employmentSessionId,
      };
      // Reuses finalizeResignationEffect() as the SINGLE canonical code-release injection point
      // (see workforce-movements.ts's own docblock) — pass codeReleaseOptions so the release is
      // tagged with the more specific "STARTED_THEN_LEFT" reason, never the generic
      // "EMPLOYMENT_ENDED" a normal resignation approval uses, and never released a second time.
      const finalizeResult = await finalizeResignationEffect(tx, movementForFinalize, input.session.username, { releaseReason: input.outcome, note: reasonText });
      await tx.update(workforceMovements).set({ lifecycleAppliedAt: new Date(), employmentSessionId: session.id }).where(eq(workforceMovements.id, movement.id));
      movementId = movement.id;
      affectedRequestIds = [];
      dwCodeReleased = finalizeResult.dwCodeReleased;
      itCodeReleased = finalizeResult.itCodeReleased;
    } else {
      await tx
        .update(employmentSessions)
        .set({
          status: "ENDED",
          endDate: todayStr(),
          endReason: input.outcome,
          endedBy: input.session.username,
          endedAt: new Date(),
        })
        .where(eq(employmentSessions.id, session.id));

      const endResult = await endActiveRequestAllocationsForWorker(
        input.workerId,
        input.session.username,
        `${outcomeLabel(input.outcome)} (session ${session.id})`,
        tx,
      );
      affectedRequestIds = endResult.affectedRequestIds;
      for (const requestId of affectedRequestIds) {
        await recomputeStoredRecruitmentBalance(tx, requestId);
      }

      const dwResult = await releaseDwCode(
        { employmentSessionId: session.id, releasedBy: input.session.username, releaseReason: input.outcome, note: reasonText },
        tx,
      );
      const itResult = await releaseItCode(
        {
          employmentSessionId: session.id,
          dailyApplicationId: session.dailyApplicationId,
          workerId: input.workerId,
          dwDataId: app.dwId,
          releasedBy: input.session.username,
          releaseReason: input.outcome,
          note: reasonText,
        },
        tx,
      );
      dwCodeReleased = dwResult.released;
      itCodeReleased = itResult.released;
    }

    const mealResult = await excludeFromMeal(
      { dailyApplicationId: app.id, excludeDate: app.regDate, reason: input.outcome, excludedBy: input.session.username },
      tx,
    );

    const [event] = await tx
      .insert(sameDayLifecycleEvents)
      .values({
        dailyApplicationId: app.id,
        employmentSessionId: session.id,
        workerId: input.workerId,
        deptId: session.deptId,
        outcome: input.outcome,
        eventAt: input.eventAt,
        reason: input.reason ?? null,
        reportedBy: input.session.username,
        mealAction: mealResult.outcome,
        dwCodeReleased,
        itCodeReleased,
        requestAllocationEnded: affectedRequestIds.length > 0 || input.outcome === "STARTED_THEN_LEFT",
        planningAllocationEnded: affectedRequestIds.length > 0 || input.outcome === "STARTED_THEN_LEFT",
        movementId,
      })
      .returning({ id: sameDayLifecycleEvents.id });

    return {
      ok: true as const,
      alreadyApplied: false,
      eventId: event.id,
      mealAction: mealResult.outcome,
      dwCodeReleased,
      itCodeReleased,
    };
  });

  if (result.ok && !result.alreadyApplied) {
    await writeAudit(
      input.session,
      "REPORT_SAME_DAY_LIFECYCLE_EVENT",
      "same_day_lifecycle_events",
      { eventId: result.eventId, workerId: input.workerId, outcome: input.outcome, mealAction: result.mealAction },
    );
    await queueNotification({
      event: "SAME_DAY_LIFECYCLE_EVENT_REPORTED",
      recipientType: "ROLE",
      recipientRef: "HR_RECRUITER",
      templateKey: "same_day_lifecycle_event_reported",
      payload: { eventId: result.eventId, workerId: input.workerId, outcome: input.outcome, reportedBy: input.session.username },
    });
  }

  return result;
}
