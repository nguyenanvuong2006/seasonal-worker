import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, employmentSessions, workerProfiles, workforceMovements } from "@/db/schema";
import { movementScopeVisibility } from "@/lib/data-scope";
import { normalizePersonName } from "@/lib/person-name";
import { todayStr } from "@/lib/helpers";

/**
 * CANONICAL CURRENT-DEPARTMENT-WORKFORCE ROSTER (Worker Lifecycle Consistency audit,
 * 2026-09-10) — the single source of truth for "who is currently in department X" (and
 * who is about to leave/arrive, or recently did), reused by "Bộ phận của tôi"
 * (department/page.tsx) and any future consumer. Deliberately reuses the EXACT canonical
 * ACTIVE predicate already established by countActiveDepartmentWorkforce()
 * (lib/recruitment-kpi.ts) — status='APPROVED' AND end_date IS NULL, worker not soft-deleted
 * — never a second, competing definition of "current."
 *
 * Previously "Bộ phận của tôi" read daily_applications.status (a registration-HISTORY
 * table per schema.ts's own EMPLOYMENT LIFECYCLE SOURCE OF TRUTH comment — never updated
 * by resignation/transfer approval) instead of employment_sessions — that mismatch, not a
 * missing effective-date check, was the root cause of the reported Production bug (an
 * approved, already-past-effective-date resignation still showing as present).
 *
 * "Sắp nghỉ"/"Sắp chuyển" (upcoming): an ACTIVE worker with an approved-but-not-yet-effective
 * movement (workforce_movements.lifecycleAppliedAt IS NULL, effectiveDate in the future) —
 * see lib/workforce-movements.ts's effective-date lifecycle. "Đã nghỉ"/"Đã thuyên chuyển"
 * (history): movements whose effect has already been applied (lifecycleAppliedAt IS NOT
 * NULL) — sourced from workforce_movements itself (full audit trail preserved), reusing
 * movementScopeVisibility() for the SAME Data Scope + redaction rules already enforced by
 * GET /api/workforce-movements, so a manager never sees a movement (or its "incoming"
 * redacted shape) they aren't authorized to see.
 */

export type RosterFilter = "ACTIVE" | "UPCOMING_RESIGNATION" | "UPCOMING_TRANSFER" | "RESIGNED" | "TRANSFERRED" | "ALL";

export type RosterRow = {
  workerId: string;
  fullName: string;
  cccd: string | null;
  gender: string | null;
  phone: string | null;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  section: string | null;
  startingDate: string | null;
  lifecycleState: "ACTIVE" | "RESIGNED" | "TRANSFERRED";
  upcoming: { type: "resignation" | "transfer"; effectiveDate: string; toDeptName: string | null } | null;
  effectiveDate: string | null;
};

const MAX_ROWS = 2000;

async function activeRows(scope: string[] | null, deptId: string | undefined, today: string, workerId?: string): Promise<RosterRow[]> {
  const conditions = [eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate), isNull(workerProfiles.deletedAt)];
  if (scope !== null) conditions.push(inArray(employmentSessions.deptId, scope));
  if (deptId) conditions.push(eq(employmentSessions.deptId, deptId));
  if (workerId) conditions.push(eq(employmentSessions.workerId, workerId));

  const rows = await db
    .select({
      workerId: workerProfiles.id,
      fullName: workerProfiles.fullName,
      cccd: workerProfiles.cccd,
      gender: workerProfiles.gender,
      phone: workerProfiles.phone,
      deptId: employmentSessions.deptId,
      deptName: departments.deptName,
      groupName: departments.groupName,
      section: departments.section,
      startingDate: employmentSessions.startingDate,
      // Sắp nghỉ/Sắp chuyển: nearest approved-but-not-yet-effective movement for this worker
      // (lifecycle_applied_at IS NULL is the canonical "not yet applied" predicate — see
      // lib/workforce-movements.ts's effective-date lifecycle. The migration that adds this
      // column has been applied to Production and verified read-only; a movement whose effect
      // was already applied — including the pre-existing rows finalized by the OLD, pre-
      // effective-date-aware code before that fix deployed — correctly falls OUT of "upcoming"
      // since its lifecycle_applied_at is already set, matching its real employment_sessions
      // state).
      upcomingType: sql<string | null>`(
        select wm.movement_type from workforce_movements wm
        where wm.worker_id = ${employmentSessions.workerId}
          and wm.effective_date > ${today}
          and wm.status in ('INACTIVE', 'TRANSFER_COMPLETED')
          and wm.lifecycle_applied_at is null
        order by wm.effective_date asc limit 1
      )`,
      upcomingEffectiveDate: sql<string | null>`(
        select wm.effective_date::text from workforce_movements wm
        where wm.worker_id = ${employmentSessions.workerId}
          and wm.effective_date > ${today}
          and wm.status in ('INACTIVE', 'TRANSFER_COMPLETED')
          and wm.lifecycle_applied_at is null
        order by wm.effective_date asc limit 1
      )`,
      upcomingToDeptName: sql<string | null>`(
        select d.dept_name from workforce_movements wm
        left join departments d on d.id = wm.to_dept_id
        where wm.worker_id = ${employmentSessions.workerId}
          and wm.effective_date > ${today}
          and wm.status in ('INACTIVE', 'TRANSFER_COMPLETED')
          and wm.lifecycle_applied_at is null
        order by wm.effective_date asc limit 1
      )`,
    })
    .from(employmentSessions)
    .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
    .where(and(...conditions))
    .orderBy(desc(employmentSessions.regDate))
    .limit(MAX_ROWS);

  return rows.map((r) => ({
    workerId: r.workerId,
    fullName: normalizePersonName(r.fullName),
    cccd: r.cccd,
    gender: r.gender,
    phone: r.phone,
    deptId: r.deptId,
    deptName: r.deptName,
    groupName: r.groupName,
    section: r.section,
    startingDate: r.startingDate,
    lifecycleState: "ACTIVE" as const,
    upcoming: r.upcomingType
      ? { type: r.upcomingType === "resignation" ? "resignation" : "transfer", effectiveDate: r.upcomingEffectiveDate!, toDeptName: r.upcomingToDeptName }
      : null,
    effectiveDate: null,
  }));
}

/**
 * History rows return the raw fromDeptId/toDeptId only (no department join) — deptName is
 * resolved CLIENT-SIDE against the already-fetched department list, the exact same convention
 * "Bộ phận của tôi" and /admin/workforce-movements already use for movement rows (see
 * page.tsx's own deptName() helper) — avoids a same-table self-join for a value the UI layer
 * already has cheaply available.
 */
async function historyRows(
  scope: string[] | null,
  deptId: string | undefined,
  movementType: "resignation" | "transfer",
): Promise<RosterRow[]> {
  // Canonical "already took effect" predicate: lifecycleAppliedAt IS NOT NULL — a terminal-
  // status movement (INACTIVE/TRANSFER_COMPLETED) whose effective date hasn't arrived yet
  // must NOT appear in history (it belongs in activeRows()'s "upcoming" badge instead).
  const terminalStatus = movementType === "resignation" ? "INACTIVE" : "TRANSFER_COMPLETED";
  const conditions = [
    eq(workforceMovements.movementType, movementType),
    eq(workforceMovements.status, terminalStatus),
    sql`${workforceMovements.lifecycleAppliedAt} is not null`,
  ];
  const rows = await db
    .select({
      workerId: workerProfiles.id,
      fullName: workerProfiles.fullName,
      cccd: workerProfiles.cccd,
      gender: workerProfiles.gender,
      phone: workerProfiles.phone,
      fromDeptId: workforceMovements.fromDeptId,
      toDeptId: workforceMovements.toDeptId,
      effectiveDate: workforceMovements.effectiveDate,
    })
    .from(workforceMovements)
    .innerJoin(workerProfiles, and(eq(workforceMovements.workerId, workerProfiles.id), isNull(workerProfiles.deletedAt)))
    .where(and(...conditions))
    .orderBy(desc(workforceMovements.effectiveDate))
    .limit(MAX_ROWS);

  return rows
    .map((r): RosterRow | null => {
      const visibility = movementScopeVisibility(scope, movementType, r.fromDeptId, r.toDeptId);
      if (visibility === "NONE") return null;
      const relevantDeptId = movementType === "resignation" ? r.fromDeptId : r.toDeptId;
      if (deptId && relevantDeptId !== deptId) return null;
      const full = visibility === "FULL";
      const state: RosterRow["lifecycleState"] = movementType === "resignation" ? "RESIGNED" : "TRANSFERRED";
      return {
        workerId: full ? r.workerId : `${r.workerId.slice(0, 4)}…`,
        fullName: full ? normalizePersonName(r.fullName) : "(ngoài Data Scope — chỉ thấy bộ phận đến)",
        cccd: full ? r.cccd : null,
        gender: full ? r.gender : null,
        phone: full ? r.phone : null,
        deptId: relevantDeptId,
        deptName: null,
        groupName: null,
        section: null,
        startingDate: null,
        lifecycleState: state,
        upcoming: null,
        effectiveDate: r.effectiveDate,
      };
    })
    .filter((r): r is RosterRow => r !== null);
}

export type WorkerCurrentState = {
  lifecycleState: "ACTIVE" | "INACTIVE";
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  section: string | null;
  startingDate: string | null;
  upcoming: { type: "resignation" | "transfer"; effectiveDate: string; toDeptName: string | null } | null;
};

/**
 * Single-worker current-state lookup (360° profile header) — the SAME
 * ACTIVE predicate as activeRows() above (status='APPROVED' AND end_date
 * IS NULL), scoped to exactly one workerId instead of scanning a whole
 * roster. Never a second, competing definition of "current." The caller's
 * OWN engagement list (assembled separately from the same employment_sessions
 * rows) is what identifies WHICH session is current — this DTO only answers
 * "what is true right now", so it deliberately carries no session id.
 *
 * Data Scope is NOT applied here deliberately: by the time a caller reaches
 * this function it has ALREADY been authorized to view this specific
 * worker (via the profile service's own scoped session check) — this only
 * answers "what IS the current state", not "may the caller see it."
 */
export async function getWorkerCurrentState(workerId: string): Promise<WorkerCurrentState> {
  const today = todayStr();
  const [active] = await activeRows(null, undefined, today, workerId);
  if (active) {
    return {
      lifecycleState: "ACTIVE",
      deptId: active.deptId,
      deptName: active.deptName,
      groupName: active.groupName,
      section: active.section,
      startingDate: active.startingDate,
      upcoming: active.upcoming,
    };
  }
  return { lifecycleState: "INACTIVE", deptId: null, deptName: null, groupName: null, section: null, startingDate: null, upcoming: null };
}

export async function getDepartmentWorkforceRoster(
  scope: string[] | null,
  filter: RosterFilter,
  deptId?: string,
): Promise<RosterRow[]> {
  if (scope !== null && scope.length === 0) return [];
  const today = todayStr();

  if (filter === "ACTIVE") return activeRows(scope, deptId, today);
  if (filter === "UPCOMING_RESIGNATION") return (await activeRows(scope, deptId, today)).filter((r) => r.upcoming?.type === "resignation");
  if (filter === "UPCOMING_TRANSFER") return (await activeRows(scope, deptId, today)).filter((r) => r.upcoming?.type === "transfer");
  if (filter === "RESIGNED") return historyRows(scope, deptId, "resignation");
  if (filter === "TRANSFERRED") return historyRows(scope, deptId, "transfer");
  // ALL: current roster (with upcoming badges) + full history trail, deliberately NOT deduped —
  // a worker who transferred in the past and is active today legitimately appears in both.
  const [active, resigned, transferred] = await Promise.all([
    activeRows(scope, deptId, today),
    historyRows(scope, deptId, "resignation"),
    historyRows(scope, deptId, "transfer"),
  ]);
  return [...active, ...resigned, ...transferred];
}
