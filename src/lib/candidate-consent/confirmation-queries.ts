/**
 * ELECTRONIC CONFIRMATION — read-only query services (2026-09-10 mission).
 *
 * The mission explicitly forbids a generic execute_sql/raw-query AI tool —
 * every reporting question gets its OWN named, typed, purpose-built query
 * function here, reused by BOTH the AI Copilot tools (tools/documents.ts)
 * and any future admin UI/report that needs the same answer. Nothing here
 * is Data-Scope-aware by itself — every function takes an explicit
 * `departmentIds: string[] | null` filter (null = unrestricted/GLOBAL,
 * [] = NONE) that the CALLER must derive from getUserScope(session) +
 * intersectDepartmentFilter first; this module never reads a session.
 *
 * EXPIRED is always derived via lifecycle.ts's effectiveStatus()/
 * isPastDeadline() — the persisted `status` column is never treated as the
 * source of truth for "is this expired", matching every other read path
 * in the feature (candidate list, admin status panel).
 *
 * Answers exactly the reporting questions the mission calls out:
 *   - "What is this worker's full Electronic Confirmation history across
 *     every engagement?"          -> getElectronicConfirmationHistory
 *   - "Which documents are ISSUED/VIEWED and still within their window?"
 *                                  -> getPendingConfirmations
 *   - "Which documents are about to expire soon?"
 *                                  -> getExpiringConfirmations
 *   - "Which documents expired without ever being confirmed?"
 *                                  -> getExpiredUnconfirmedDocuments
 */

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { candidateDocuments, dailyApplications, documentConfirmations, employmentSessions, workerProfiles } from "@/db/schema";
import { effectiveStatus, isPastDeadline, type CandidateDocumentStatus } from "./lifecycle";

const HARD_MAX_ROWS = 50;

export type ConfirmationHistoryEntry = {
  documentId: string;
  applicationId: string;
  employmentSessionId: string | null;
  engagementStartingDate: string | null;
  templateVersion: number | null;
  documentKind: string | null;
  status: CandidateDocumentStatus;
  effectiveStatus: string;
  issuedAt: string | null;
  confirmationDeadlineAt: string | null;
  viewedAt: string | null;
  confirmedAt: string | null;
  receiptId: string | null;
};

/**
 * Full per-engagement Electronic Confirmation history for ONE worker,
 * newest engagement first. A worker who has begun work N times has N
 * independent document lineages here — an old CONFIRMED document is never
 * dropped, overwritten, or merged with a newer one (the STRICT
 * engagement-based-history invariant this mission requires).
 */
export async function getElectronicConfirmationHistory(workerId: string): Promise<ConfirmationHistoryEntry[]> {
  const sessions = await db
    .select({ id: employmentSessions.id, startingDate: employmentSessions.startingDate })
    .from(employmentSessions)
    .where(eq(employmentSessions.workerId, workerId));
  if (sessions.length === 0) return [];

  const startingDateBySession = new Map(sessions.map((s) => [s.id, s.startingDate]));
  const sessionIds = sessions.map((s) => s.id);

  const rows = await db
    .select({
      id: candidateDocuments.id,
      applicationId: candidateDocuments.applicationId,
      employmentSessionId: candidateDocuments.employmentSessionId,
      templateVersion: candidateDocuments.templateVersion,
      documentKind: candidateDocuments.documentKind,
      status: candidateDocuments.status,
      issuedAt: candidateDocuments.issuedAt,
      confirmationDeadlineAt: candidateDocuments.confirmationDeadlineAt,
      viewedAt: candidateDocuments.viewedAt,
    })
    .from(candidateDocuments)
    .where(inArray(candidateDocuments.employmentSessionId, sessionIds));
  if (rows.length === 0) return [];

  const confirmations = await db
    .select({ candidateDocumentId: documentConfirmations.candidateDocumentId, confirmedAtServer: documentConfirmations.confirmedAtServer, receiptId: documentConfirmations.receiptId })
    .from(documentConfirmations)
    .where(inArray(documentConfirmations.candidateDocumentId, rows.map((r) => r.id)));
  const confirmationByDoc = new Map(confirmations.map((c) => [c.candidateDocumentId, c]));

  const now = new Date();
  const entries: ConfirmationHistoryEntry[] = rows.map((r) => {
    const confirmation = confirmationByDoc.get(r.id) ?? null;
    return {
      documentId: r.id,
      applicationId: r.applicationId,
      employmentSessionId: r.employmentSessionId,
      engagementStartingDate: r.employmentSessionId ? (startingDateBySession.get(r.employmentSessionId) ?? null) : null,
      templateVersion: r.templateVersion,
      documentKind: r.documentKind,
      status: r.status as CandidateDocumentStatus,
      effectiveStatus: effectiveStatus(r.status as CandidateDocumentStatus, r.confirmationDeadlineAt, now),
      issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
      confirmationDeadlineAt: r.confirmationDeadlineAt ? r.confirmationDeadlineAt.toISOString() : null,
      viewedAt: r.viewedAt ? r.viewedAt.toISOString() : null,
      confirmedAt: confirmation ? confirmation.confirmedAtServer.toISOString() : null,
      receiptId: confirmation ? confirmation.receiptId : null,
    };
  });

  // Newest engagement first — by engagement start date when known, falling
  // back to issuedAt for a document whose engagement link is legacy/unset.
  entries.sort((a, b) => {
    const aKey = a.engagementStartingDate ?? a.issuedAt ?? "";
    const bKey = b.engagementStartingDate ?? b.issuedAt ?? "";
    return bKey.localeCompare(aKey);
  });
  return entries;
}

export type ActionableConfirmationEntry = {
  documentId: string;
  applicationId: string;
  applicantFullName: string;
  deptId: string | null;
  status: "ISSUED" | "VIEWED";
  issuedAt: string | null;
  confirmationDeadlineAt: string;
};

async function fetchActionableRows(departmentIds: string[] | null): Promise<ActionableConfirmationEntry[]> {
  if (departmentIds !== null && departmentIds.length === 0) return [];
  const conditions = [inArray(candidateDocuments.status, ["ISSUED", "VIEWED"])];
  if (departmentIds !== null) conditions.push(inArray(dailyApplications.deptId, departmentIds));

  const rows = await db
    .select({
      id: candidateDocuments.id,
      applicationId: candidateDocuments.applicationId,
      status: candidateDocuments.status,
      issuedAt: candidateDocuments.issuedAt,
      confirmationDeadlineAt: candidateDocuments.confirmationDeadlineAt,
      applicantFullName: dailyApplications.fullName,
      deptId: dailyApplications.deptId,
    })
    .from(candidateDocuments)
    .innerJoin(dailyApplications, eq(candidateDocuments.applicationId, dailyApplications.id))
    .where(and(...conditions));

  // A document with no deadline (legacy, pre-feature) is never past due and
  // never "expiring" — it simply has no deadline-driven urgency to report.
  return rows
    .filter((r) => r.confirmationDeadlineAt !== null)
    .map((r) => ({
      documentId: r.id,
      applicationId: r.applicationId,
      applicantFullName: r.applicantFullName,
      deptId: r.deptId,
      status: r.status as "ISSUED" | "VIEWED",
      issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
      confirmationDeadlineAt: r.confirmationDeadlineAt!.toISOString(),
    }));
}

/** ISSUED/VIEWED documents still within their confirmation window — soonest deadline first. */
export async function getPendingConfirmations(departmentIds: string[] | null, limit: number): Promise<ActionableConfirmationEntry[]> {
  const now = new Date();
  const rows = await fetchActionableRows(departmentIds);
  return rows
    .filter((r) => !isPastDeadline(new Date(r.confirmationDeadlineAt), now))
    .sort((a, b) => new Date(a.confirmationDeadlineAt).getTime() - new Date(b.confirmationDeadlineAt).getTime())
    .slice(0, Math.min(limit, HARD_MAX_ROWS));
}

/** ISSUED/VIEWED documents whose deadline falls within the next `withinHours` — soonest first. Subset of getPendingConfirmations. */
export async function getExpiringConfirmations(departmentIds: string[] | null, withinHours: number, limit: number): Promise<ActionableConfirmationEntry[]> {
  const now = new Date();
  const thresholdMs = now.getTime() + withinHours * 60 * 60 * 1000;
  const rows = await fetchActionableRows(departmentIds);
  return rows
    .filter((r) => {
      const deadlineMs = new Date(r.confirmationDeadlineAt).getTime();
      return deadlineMs > now.getTime() && deadlineMs <= thresholdMs;
    })
    .sort((a, b) => new Date(a.confirmationDeadlineAt).getTime() - new Date(b.confirmationDeadlineAt).getTime())
    .slice(0, Math.min(limit, HARD_MAX_ROWS));
}

/** ISSUED/VIEWED documents already past their deadline (effectiveStatus=EXPIRED) — never confirmed in time. Most-overdue first. */
export async function getExpiredUnconfirmedDocuments(departmentIds: string[] | null, limit: number): Promise<ActionableConfirmationEntry[]> {
  const now = new Date();
  const rows = await fetchActionableRows(departmentIds);
  return rows
    .filter((r) => isPastDeadline(new Date(r.confirmationDeadlineAt), now))
    .sort((a, b) => new Date(a.confirmationDeadlineAt).getTime() - new Date(b.confirmationDeadlineAt).getTime())
    .slice(0, Math.min(limit, HARD_MAX_ROWS));
}
