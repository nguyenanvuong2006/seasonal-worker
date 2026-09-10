/**
 * STRICTLY READ-ONLY Production diagnostic (2026-09, Worker Lifecycle Consistency mission,
 * Part C/N) — finds APPROVED resignation/transfer movements whose canonical employment_sessions
 * state was NEVER actually finalized under the CURRENT (pre-fix) code, which ends a session /
 * moves a department IMMEDIATELY at approval time regardless of effective date. A "stale" row
 * here means the approval decision (workforce_movements.status) was recorded but the real
 * workforce state change never landed — e.g. no active/fallback employment session existed for
 * that worker at approval time. This is a DIFFERENT, narrower question than "is this movement's
 * effective date in the future" (that's an expected, new, and safe state under the fix — not
 * staleness) — this diagnostic is about a genuine historical gap that would need a data repair.
 *
 * Runs against the CURRENT (pre-migration) schema — workforce_movements has no
 * lifecycle_applied_at column yet at the time this is meant to run, so staleness is inferred by
 * cross-checking against employment_sessions.end_movement_id / deptId directly, not that column.
 *
 * ZERO writes anywhere: only SELECT. Never touches employment_sessions/workforce_movements/any
 * business row. Never prints CCCD/phone/address/DOB — only workerId (operational identifier,
 * safe — see repo-wide convention in the sibling diagnose-*.ts scripts), display name (via
 * normalizePersonName), department id, and movement id/effectiveDate.
 *
 * Cách dùng:
 *   DATABASE_URL=... node --import tsx scripts/diagnose-workforce-movement-lifecycle-staleness.ts
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import { employmentSessions, workforceMovements, workerProfiles } from "../src/db/schema.ts";
import { normalizePersonName } from "../src/lib/person-name.ts";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  const approvedResignations = await db
    .select({ id: workforceMovements.id, workerId: workforceMovements.workerId, effectiveDate: workforceMovements.effectiveDate })
    .from(workforceMovements)
    .where(and(eq(workforceMovements.movementType, "resignation"), eq(workforceMovements.status, "INACTIVE")));

  const approvedTransfers = await db
    .select({ id: workforceMovements.id, workerId: workforceMovements.workerId, toDeptId: workforceMovements.toDeptId, effectiveDate: workforceMovements.effectiveDate })
    .from(workforceMovements)
    .where(and(eq(workforceMovements.movementType, "transfer"), eq(workforceMovements.status, "TRANSFER_COMPLETED")));

  log("APPROVED_MOVEMENTS_SCANNED", { resignations: approvedResignations.length, transfers: approvedTransfers.length });

  // A resignation is FINALIZED if some employment_sessions row was actually ended BY this
  // movement (end_movement_id = movement.id). No such row = the approval never took real effect.
  const resignationMovementIds = approvedResignations.map((m) => m.id);
  const endedByMovementIds = new Set(
    resignationMovementIds.length
      ? (
          await db
            .select({ endMovementId: employmentSessions.endMovementId })
            .from(employmentSessions)
            .where(inArray(employmentSessions.endMovementId, resignationMovementIds))
        )
          .map((r) => r.endMovementId)
          .filter((id): id is string => !!id)
      : [],
  );

  const staleResignations = approvedResignations.filter((m) => !endedByMovementIds.has(m.id));

  // A transfer is FINALIZED if the worker's CURRENT employment session's deptId matches the
  // movement's toDeptId (the only signal available pre-migration — the old code mutates deptId
  // in place with no other trail). A worker with more than one session, or whose current
  // session no longer matches for an unrelated later reason, is reported but not assumed guilty
  // — see note in the log line.
  const transferWorkerIds = approvedTransfers.map((m) => m.workerId);
  const currentSessions = transferWorkerIds.length
    ? await db
        .select({ workerId: employmentSessions.workerId, deptId: employmentSessions.deptId })
        .from(employmentSessions)
        .where(and(inArray(employmentSessions.workerId, transferWorkerIds), eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate)))
    : [];
  const currentDeptByWorker = new Map(currentSessions.map((s) => [s.workerId, s.deptId]));
  const staleTransfers = approvedTransfers.filter((m) => currentDeptByWorker.get(m.workerId) !== m.toDeptId);

  log("STALE_RESIGNATION_COUNT", { value: staleResignations.length });
  log("STALE_TRANSFER_COUNT", { value: staleTransfers.length });

  if (staleResignations.length === 0 && staleTransfers.length === 0) {
    log("no_staleness_found", { note: "Every approved resignation/transfer's real workforce state was already finalized under the current code — no repair needed." });
    await pool.end();
    return;
  }

  const workerIds = [...new Set([...staleResignations.map((m) => m.workerId), ...staleTransfers.map((m) => m.workerId)])];
  const profiles = workerIds.length ? await db.select({ id: workerProfiles.id, fullName: workerProfiles.fullName }).from(workerProfiles).where(inArray(workerProfiles.id, workerIds)) : [];
  const nameByWorker = new Map(profiles.map((p) => [p.id, normalizePersonName(p.fullName) || "(chưa rõ tên)"]));

  for (const m of staleResignations) {
    log("STALE_RESIGNATION", { movementId: m.id, workerId: m.workerId, displayName: nameByWorker.get(m.workerId) ?? "(không rõ)", effectiveDate: m.effectiveDate });
  }
  for (const m of staleTransfers) {
    log("STALE_TRANSFER", { movementId: m.id, workerId: m.workerId, displayName: nameByWorker.get(m.workerId) ?? "(không rõ)", expectedToDeptId: m.toDeptId, effectiveDate: m.effectiveDate });
  }

  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "fatal_error", error: message.slice(0, 500) }));
  process.exit(1);
});
