/**
 * WORKER 360° PROFILE — canonical read service (2026-09-10+ mission).
 *
 * The single assembly point for "Hồ sơ Tập nghề"'s per-person profile —
 * the SAME service backs the admin page route AND the AI Copilot's
 * get_worker_employment_history tool, so both surfaces are guaranteed to
 * agree (never two competing definitions of a worker's history).
 *
 * IDENTITY GRAPH (audited, no name-based joins — see PR description):
 *   worker_profiles (CANONICAL PERSON, id: uuid)
 *     <- employment_sessions.workerId (NOT NULL FK)      — 1 row = 1 ENGAGEMENT
 *          -> employment_sessions.dailyApplicationId (nullable, UNIQUE when set) -> daily_applications.id
 *          <- workforce_movements.employmentSessionId (nullable FK; workerId is ALSO directly on the row)
 *          <- candidate_documents.employmentSessionId (nullable FK, PR #188 deterministic backfill)
 * daily_applications has NO direct FK to worker_profiles — reachable only via employment_sessions.
 *
 * TRANSFER DOES NOT CREATE A NEW SESSION — finalizeTransferEffect() (workforce-movements.ts)
 * mutates the SAME session's deptId in place. The only historical trail of "department
 * before the transfer" is workforce_movements.fromDeptId/toDeptId, so department HISTORY is
 * reconstructed from movements here, never inferred from employment_sessions.deptId alone
 * (which only ever holds the CURRENT value).
 *
 * DATA SCOPE (reused, never reinvented): an engagement is visible only when its
 * employment_sessions.deptId is in the caller's scope (same rule scopedProfileAndSessions()
 * already used) — a worker who was ONCE in a manager's department but is now elsewhere (or
 * vice versa) never has their OTHER engagements leaked just because ONE engagement matches.
 * Movements inside a visible engagement are still individually redacted via the EXACT
 * movementScopeVisibility() function GET /api/workforce-movements already uses.
 *
 * LEGACY/UNLINKED: a candidate_documents row with employmentSessionId IS NULL is attributable
 * to this worker ONLY via a deterministic daily_applications.cccd = worker_profiles.cccd match
 * (both are stable government-ID fields, never a name heuristic) — anything that doesn't match
 * this way is simply invisible everywhere, per the mission's "never guess" rule. A workforce_
 * movements row with employmentSessionId IS NULL (pre-dates that FK) is still directly
 * attributable to the worker via its own workerId column, but not to any SPECIFIC engagement —
 * surfaced separately, never guessed onto one.
 */

import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { candidateDocuments, dailyApplications, departments, documentConfirmations, employmentSessions, workerProfiles, workforceMovements } from "@/db/schema";
import { getWorkerCurrentState, type WorkerCurrentState } from "./workforce-roster";
import { getElectronicConfirmationHistory, type ConfirmationHistoryEntry } from "./candidate-consent/confirmation-queries";
import { effectiveStatus, type CandidateDocumentStatus } from "./candidate-consent/lifecycle";
import { movementScopeVisibility } from "./data-scope";
import { normalizePersonName } from "./person-name";

export type EngagementMovement = {
  id: string;
  movementType: "resignation" | "transfer";
  fromDeptId: string | null;
  fromDeptName: string | null;
  toDeptId: string | null;
  toDeptName: string | null;
  effectiveDate: string;
  status: string;
  reason: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  lifecycleAppliedAt: string | null;
};

export type Engagement = {
  session: {
    id: string;
    regDate: string;
    status: string;
    startingDate: string | null;
    endDate: string | null;
    endReason: string | null;
    endedBy: string | null;
    startDateSource: string | null;
    dailyApplicationId: string | null;
    note: string | null;
    itCode: string | null;
  };
  organization: { deptId: string | null; deptName: string | null; groupName: string | null; section: string | null };
  isCurrent: boolean;
  movements: EngagementMovement[];
  electronicDocuments: ConfirmationHistoryEntry[];
};

export type Worker360Profile = {
  person: {
    workerId: string;
    fullName: string;
    fingerprintStatus: string | null;
    hasFingerprintCode: boolean;
  };
  currentState: WorkerCurrentState;
  engagements: Engagement[];
  /** candidate_documents with NO employment_session link, deterministically attributable to this worker by CCCD only — never guessed onto an engagement. */
  legacyUnlinkedDocuments: ConfirmationHistoryEntry[];
  /** workforce_movements with NO employment_session link (pre-dates that FK) — attributable to the worker but not to any specific engagement. */
  unlinkedMovements: EngagementMovement[];
};

function toMovement(
  m: { id: string; movementType: string; fromDeptId: string | null; toDeptId: string | null; effectiveDate: string; status: string; reason: string | null; confirmedBy: string | null; confirmedAt: Date | null; lifecycleAppliedAt: Date | null },
  deptNameById: Map<string, string>,
): EngagementMovement {
  return {
    id: m.id,
    movementType: m.movementType as "resignation" | "transfer",
    fromDeptId: m.fromDeptId,
    fromDeptName: m.fromDeptId ? (deptNameById.get(m.fromDeptId) ?? null) : null,
    toDeptId: m.toDeptId,
    toDeptName: m.toDeptId ? (deptNameById.get(m.toDeptId) ?? null) : null,
    effectiveDate: m.effectiveDate,
    status: m.status,
    reason: m.reason,
    confirmedBy: m.confirmedBy,
    confirmedAt: m.confirmedAt ? m.confirmedAt.toISOString() : null,
    lifecycleAppliedAt: m.lifecycleAppliedAt ? m.lifecycleAppliedAt.toISOString() : null,
  };
}

/**
 * Assembles the full 360° profile for one worker, already Data-Scope-
 * filtered to exactly what the caller may see. Returns null when the
 * worker doesn't exist, is soft-deleted, OR (for a scoped caller) has zero
 * engagements within scope — same "never a global existence oracle"
 * contract the pre-existing CCCD-based route already established.
 *
 * Bounded, non-N+1: every child table is fetched with ONE query keyed by
 * either workerId or the already-resolved session-id list, never per-
 * engagement round trips.
 */
export async function getWorker360Profile(workerId: string, scope: string[] | null): Promise<Worker360Profile | null> {
  if (scope !== null && scope.length === 0) return null;

  const [profile] = await db.select().from(workerProfiles).where(and(eq(workerProfiles.id, workerId), isNull(workerProfiles.deletedAt)));
  if (!profile) return null;

  const sessionFilters = [eq(employmentSessions.workerId, workerId)];
  if (scope !== null) sessionFilters.push(inArray(employmentSessions.deptId, scope));
  const sessionRows = await db
    .select({
      id: employmentSessions.id,
      regDate: employmentSessions.regDate,
      status: employmentSessions.status,
      startingDate: employmentSessions.startingDate,
      endDate: employmentSessions.endDate,
      endReason: employmentSessions.endReason,
      endedBy: employmentSessions.endedBy,
      startDateSource: employmentSessions.startDateSource,
      dailyApplicationId: employmentSessions.dailyApplicationId,
      note: employmentSessions.note,
      deptId: employmentSessions.deptId,
    })
    .from(employmentSessions)
    .where(and(...sessionFilters))
    .orderBy(desc(employmentSessions.regDate));
  if (scope !== null && sessionRows.length === 0) return null;

  const sessionIds = sessionRows.map((s) => s.id);

  // Movements are fetched up front (not inside the Promise.all below) because
  // department HISTORY comes from movement fromDeptId/toDeptId, not just each
  // session's CURRENT deptId (see TRANSFER DOES NOT CREATE A NEW SESSION in the
  // module docblock) — the departments query below must cover BOTH sources or a
  // completed transfer's historical "from" department name resolves to null.
  const movementRows = await db.select().from(workforceMovements).where(eq(workforceMovements.workerId, workerId)).orderBy(desc(workforceMovements.effectiveDate));

  const deptIds = [
    ...new Set([
      ...sessionRows.map((s) => s.deptId).filter((id): id is string => id !== null),
      ...movementRows.map((m) => m.fromDeptId).filter((id): id is string => id !== null),
      ...movementRows.map((m) => m.toDeptId).filter((id): id is string => id !== null),
    ]),
  ];

  const [deptRows, appRows, allConfirmationHistory, legacyDocRows] = await Promise.all([
    deptIds.length ? db.select({ id: departments.id, deptName: departments.deptName, groupName: departments.groupName, section: departments.section }).from(departments).where(inArray(departments.id, deptIds)) : Promise.resolve([]),
    sessionRows.some((s) => s.dailyApplicationId)
      ? db
          .select({ id: dailyApplications.id, itCode: dailyApplications.itCode })
          .from(dailyApplications)
          .where(inArray(dailyApplications.id, sessionRows.map((s) => s.dailyApplicationId).filter((id): id is string => id !== null)))
      : Promise.resolve([]),
    getElectronicConfirmationHistory(workerId),
    // Legacy/unlinked candidate_documents attributable to this worker by CCCD only — a
    // deterministic government-ID match, never a name heuristic. Documents already linked
    // to one of this worker's OWN sessions are excluded (they belong in engagements[]).
    db
      .select({
        id: candidateDocuments.id,
        applicationId: candidateDocuments.applicationId,
        templateVersion: candidateDocuments.templateVersion,
        documentKind: candidateDocuments.documentKind,
        status: candidateDocuments.status,
        issuedAt: candidateDocuments.issuedAt,
        confirmationDeadlineAt: candidateDocuments.confirmationDeadlineAt,
        viewedAt: candidateDocuments.viewedAt,
        supersedesDocumentId: candidateDocuments.supersedesDocumentId,
      })
      .from(candidateDocuments)
      .innerJoin(dailyApplications, eq(candidateDocuments.applicationId, dailyApplications.id))
      .where(and(isNull(candidateDocuments.employmentSessionId), eq(dailyApplications.cccd, profile.cccd))),
  ]);

  const deptNameById = new Map(deptRows.map((d) => [d.id, d.deptName]));
  const deptById = new Map(deptRows.map((d) => [d.id, d]));
  const itCodeByAppId = new Map(appRows.map((a) => [a.id, a.itCode]));

  const movementsBySession = new Map<string, EngagementMovement[]>();
  const unlinkedMovements: EngagementMovement[] = [];
  for (const m of movementRows) {
    const visibility = movementScopeVisibility(scope, m.movementType, m.fromDeptId, m.toDeptId);
    if (visibility === "NONE") continue;
    const shaped = toMovement(m, deptNameById);
    if (visibility === "REDACTED_INCOMING") {
      shaped.fromDeptId = null;
      shaped.fromDeptName = null;
    }
    if (m.employmentSessionId && sessionIds.includes(m.employmentSessionId)) {
      const list = movementsBySession.get(m.employmentSessionId) ?? [];
      list.push(shaped);
      movementsBySession.set(m.employmentSessionId, list);
    } else if (!m.employmentSessionId) {
      unlinkedMovements.push(shaped);
    }
    // A movement whose employmentSessionId points to a session OUTSIDE this
    // worker's OWN scoped session list (should never happen — workerId and
    // employmentSessionId are set together — kept as a silent no-op guard
    // rather than surfaced, since it can't legitimately occur).
  }

  const docsBySession = new Map<string, ConfirmationHistoryEntry[]>();
  for (const doc of allConfirmationHistory) {
    if (!doc.employmentSessionId || !sessionIds.includes(doc.employmentSessionId)) continue;
    const list = docsBySession.get(doc.employmentSessionId) ?? [];
    list.push(doc);
    docsBySession.set(doc.employmentSessionId, list);
  }

  const legacyConfirmations = legacyDocRows.length
    ? await db
        .select({ candidateDocumentId: documentConfirmations.candidateDocumentId, confirmedAtServer: documentConfirmations.confirmedAtServer, receiptId: documentConfirmations.receiptId })
        .from(documentConfirmations)
        .where(inArray(documentConfirmations.candidateDocumentId, legacyDocRows.map((r) => r.id)))
    : [];
  const legacyConfirmationByDoc = new Map(legacyConfirmations.map((c) => [c.candidateDocumentId, c]));

  const engagements: Engagement[] = sessionRows.map((s) => {
    const dept = s.deptId ? deptById.get(s.deptId) : undefined;
    return {
      session: {
        id: s.id,
        regDate: s.regDate,
        status: s.status,
        startingDate: s.startingDate,
        endDate: s.endDate,
        endReason: s.endReason,
        endedBy: s.endedBy,
        startDateSource: s.startDateSource,
        dailyApplicationId: s.dailyApplicationId,
        note: s.note,
        itCode: s.dailyApplicationId ? (itCodeByAppId.get(s.dailyApplicationId) ?? null) : null,
      },
      organization: { deptId: s.deptId, deptName: dept?.deptName ?? null, groupName: dept?.groupName ?? null, section: dept?.section ?? null },
      isCurrent: s.status === "APPROVED" && s.endDate === null,
      movements: movementsBySession.get(s.id) ?? [],
      electronicDocuments: docsBySession.get(s.id) ?? [],
    };
  });

  const currentState = await getWorkerCurrentState(workerId);

  return {
    person: {
      workerId: profile.id,
      fullName: normalizePersonName(profile.fullName),
      fingerprintStatus: profile.fingerprintStatus,
      hasFingerprintCode: !!profile.fingerprintCode,
    },
    currentState,
    engagements,
    legacyUnlinkedDocuments: legacyDocRows.map((r) => {
      const confirmation = legacyConfirmationByDoc.get(r.id) ?? null;
      return {
        documentId: r.id,
        applicationId: r.applicationId,
        employmentSessionId: null,
        engagementStartingDate: null,
        templateVersion: r.templateVersion,
        templateName: null,
        documentKind: r.documentKind,
        status: r.status as CandidateDocumentStatus,
        effectiveStatus: effectiveStatus(r.status as CandidateDocumentStatus, r.confirmationDeadlineAt, new Date()),
        issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
        confirmationDeadlineAt: r.confirmationDeadlineAt ? r.confirmationDeadlineAt.toISOString() : null,
        viewedAt: r.viewedAt ? r.viewedAt.toISOString() : null,
        confirmedAt: confirmation ? confirmation.confirmedAtServer.toISOString() : null,
        receiptId: confirmation ? confirmation.receiptId : null,
        supersedesDocumentId: r.supersedesDocumentId,
      };
    }),
    unlinkedMovements,
  };
}
