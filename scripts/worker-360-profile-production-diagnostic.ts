/**
 * STRICTLY READ-ONLY Production diagnostic (Worker 360° Profile mission,
 * 2026-09-10, Section 23). Answers the mission's own data-model questions
 * about the identity graph getWorker360Profile() (src/lib/worker-360-profile.ts)
 * reads from, WITHOUT touching any row: worker_profiles <- employment_sessions
 * (1 row = 1 ENGAGEMENT) <- candidate_documents / workforce_movements.
 *
 * ZERO writes anywhere: every query below is a SELECT/COUNT/GROUP BY. Never
 * prints a name, CCCD, phone, or any other PII/free-text field — only
 * aggregate counts, matching the mission's explicit "no PII in diagnostic
 * logs" requirement (stricter than some earlier diagnose-*.ts scripts in
 * this repo that printed a normalizePersonName display name — this one
 * prints NOTHING per-worker at all, aggregate numbers only).
 *
 * MOVEMENTS_WITH_AMBIGUOUS_HISTORY: a workforce_movements row with NO
 * employment_session_id is only genuinely AMBIGUOUS (which of the worker's
 * engagements it belongs to is unknowable) when that worker has MORE THAN
 * ONE employment_sessions row — a worker with exactly one session has an
 * unlinked movement that is trivially attributable (though
 * worker-360-profile.ts still never guesses it onto that session, per the
 * mission's "never infer by dates alone" rule) rather than ambiguous.
 *
 * Cách dùng:
 *   DATABASE_URL=... node --import tsx scripts/worker-360-profile-production-diagnostic.ts
 */
import { isNull, sql } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import { candidateDocuments, employmentSessions, workerProfiles, workforceMovements } from "../src/db/schema.ts";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  const [[{ count: totalWorkerProfiles }], [{ count: totalEmploymentSessions }]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(workerProfiles),
    db.select({ count: sql<number>`count(*)::int` }).from(employmentSessions),
  ]);
  log("TOTAL_WORKER_PROFILES", { value: totalWorkerProfiles });
  log("TOTAL_EMPLOYMENT_SESSIONS", { value: totalEmploymentSessions });

  const sessionsPerWorker = await db
    .select({ workerId: employmentSessions.workerId, sessionCount: sql<number>`count(*)::int` })
    .from(employmentSessions)
    .groupBy(employmentSessions.workerId);
  const workersWithMultipleSessions = sessionsPerWorker.filter((r) => r.sessionCount >= 2).length;
  const maxSessionsPerWorker = sessionsPerWorker.reduce((max, r) => Math.max(max, r.sessionCount), 0);
  log("WORKERS_WITH_MULTIPLE_SESSIONS", { value: workersWithMultipleSessions });
  log("MAX_SESSIONS_PER_WORKER", { value: maxSessionsPerWorker });

  const [[{ count: documentsLinked }], [{ count: documentsLegacyUnlinked }]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(candidateDocuments).where(sql`${candidateDocuments.employmentSessionId} is not null`),
    db.select({ count: sql<number>`count(*)::int` }).from(candidateDocuments).where(isNull(candidateDocuments.employmentSessionId)),
  ]);
  log("DOCUMENTS_LINKED_TO_SESSIONS", { value: documentsLinked });
  log("DOCUMENTS_LEGACY_UNLINKED", { value: documentsLegacyUnlinked });

  const [[{ count: movementsLinkable }]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(workforceMovements).where(sql`${workforceMovements.employmentSessionId} is not null`),
  ]);
  log("MOVEMENTS_LINKABLE_TO_SESSIONS", { value: movementsLinkable });

  const sessionCountByWorker = new Map(sessionsPerWorker.map((r) => [r.workerId, r.sessionCount]));
  const unlinkedMovements = await db.select({ workerId: workforceMovements.workerId }).from(workforceMovements).where(isNull(workforceMovements.employmentSessionId));
  const movementsWithAmbiguousHistory = unlinkedMovements.filter((m) => (sessionCountByWorker.get(m.workerId) ?? 0) >= 2).length;
  log("MOVEMENTS_UNLINKED_TOTAL", { value: unlinkedMovements.length });
  log("MOVEMENTS_WITH_AMBIGUOUS_HISTORY", { value: movementsWithAmbiguousHistory });

  log("diagnostic_complete", { note: "Read-only — zero rows written or modified." });
  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "fatal_error", error: message.slice(0, 500) }));
  process.exit(1);
});
