/**
 * STRICTLY READ-ONLY Production re-verification — calls the REAL services
 * (not raw SQL) after the workforce-movement effective-lifecycle migration
 * (PR #193) and its reconciliation (PR #195) to confirm the originally
 * reported features still work AND now use the real lifecycle_applied_at
 * column. Zero writes anywhere.
 *
 * Section 10 of the workforce-movement effective-lifecycle migration
 * mission. Never logs worker names/CCCD/phone — only ids, counts, dates,
 * and booleans.
 *
 * Cách dùng (LƯU Ý --conditions=react-server, xem
 * diagnose-worker-360-profile-endpoint-error.ts để biết lý do):
 *   DATABASE_URL=... node --conditions=react-server --import tsx scripts/reverify-worker-lifecycle-features-post-migration.ts
 */
import { and, eq, lte, sql } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import { workforceMovements } from "../src/db/schema.ts";
import { getWorker360Profile } from "../src/lib/worker-360-profile.ts";
import { getDepartmentWorkforceRoster } from "../src/lib/workforce-roster.ts";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  log("start", { today });

  const active = await getDepartmentWorkforceRoster(null, "ACTIVE");
  const distinctStartingDates = new Set(active.map((r) => r.startingDate).filter(Boolean));
  const upcomingCount = active.filter((r) => r.upcoming !== null).length;
  log("MY_DEPARTMENT_ROSTER_ACTIVE", {
    rowCount: active.length,
    distinctStartingDateCount: distinctStartingDates.size,
    note: "distinctStartingDateCount > 1 proves the default view isn't just 'today's intake'",
    upcomingBadgeCount: upcomingCount,
  });

  const [effectiveCase] = await db
    .select({ id: workforceMovements.id, workerId: workforceMovements.workerId, effectiveDate: workforceMovements.effectiveDate, lifecycleAppliedAt: workforceMovements.lifecycleAppliedAt })
    .from(workforceMovements)
    .where(and(eq(workforceMovements.movementType, "resignation"), eq(workforceMovements.status, "INACTIVE"), lte(workforceMovements.effectiveDate, today), sql`${workforceMovements.lifecycleAppliedAt} is not null`))
    .orderBy(workforceMovements.effectiveDate)
    .limit(1);

  if (!effectiveCase) {
    log("EFFECTIVE_RESIGNATION_CASE", { note: "NO_REAL_PRODUCTION_CASE" });
  } else {
    const stillActive = active.some((r) => r.workerId === effectiveCase.workerId);
    const resignedHistory = await getDepartmentWorkforceRoster(null, "RESIGNED");
    const inHistory = resignedHistory.some((r) => r.workerId === effectiveCase.workerId);
    let movementLifecycleAppliedAt: string | null = null;
    let profileFound = false;
    try {
      const profile = await getWorker360Profile(effectiveCase.workerId, null);
      profileFound = !!profile;
      if (profile) {
        const movement = profile.engagements.flatMap((e) => e.movements).concat(profile.unlinkedMovements).find((m) => m.id === effectiveCase.id);
        movementLifecycleAppliedAt = movement?.lifecycleAppliedAt ?? null;
      }
    } catch (error) {
      log("WORKER_360_PROFILE_ERROR", { message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
    log("EFFECTIVE_RESIGNATION_CASE", {
      movementId: effectiveCase.id,
      effectiveDate: effectiveCase.effectiveDate,
      lifecycleAppliedAtSet: effectiveCase.lifecycleAppliedAt !== null,
      stillInActiveRoster: stillActive,
      inResignedHistory: inHistory,
      profileFound,
      profileReportsRealLifecycleAppliedAt: movementLifecycleAppliedAt !== null,
      pass: !stillActive && inHistory,
    });
  }

  const transferred = await getDepartmentWorkforceRoster(null, "TRANSFERRED");
  log("TRANSFER_LIST", { rowCount: transferred.length, note: "0 expected — no transfer movements exist in Production" });

  const all = await getDepartmentWorkforceRoster(null, "ALL");
  log("ALL_FILTER_SANITY", { rowCount: all.length });

  log("reverify_complete", { note: "Read-only — zero rows written or modified." });
  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "fatal_error", error: message.slice(0, 500) }));
  process.exit(1);
});
