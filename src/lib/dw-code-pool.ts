import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { dwCodeAssignments, dwCodeLocations, dwCodes, dwData } from "@/db/schema";

/** Same pattern as workforce-request.ts/planning.ts/recruitment-kpi.ts — accepts either the top-level `db` or an existing transaction, so callers orchestrating multiple domains (e.g. same-day-lifecycle.ts) can compose this into ONE atomic transaction instead of nesting a second one. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * MISSION E — INTERNAL DW CODE (location-aware operational code) pool.
 * ------------------------------------------------------------------
 * `dw_data.code` remains the READ MIRROR every existing screen already
 * reads (daily-code-list.ts, fingerprint-it-code-list.ts, meal-list.ts's
 * eligibility rule via isEligibleForFingerprintQueue/isEligibleForMealExport).
 * This module is the ONLY writer that should ever set/clear that mirror
 * going forward for pool-issued codes — it always keeps `dw_codes` +
 * `dw_code_assignments` (the real history) and `dw_data.code` (the mirror)
 * in the same transaction, so they can never drift.
 *
 * REUSE POLICY (mission section 49, explicit deterministic strategy):
 *   1. an AVAILABLE released code for the location, lowest sequence first;
 *   2. otherwise atomically consume the location's next sequence number.
 * `dw_codes.status` is AVAILABLE | ASSIGNED | RETIRED — RELEASED is
 * modeled as an EVENT (dw_code_assignments.releasedAt/releaseReason), not
 * a separate persistent code state: releasing a code makes it immediately
 * AVAILABLE again for reuse (see schema.ts docblock for the full
 * rationale). RETIRED is one-way (MANUAL_CORRECTION only).
 */

export type ReleaseReason =
  | "NO_SHOW"
  | "DECLINED_AT_START"
  | "STARTED_THEN_LEFT"
  | "EMPLOYMENT_ENDED"
  | "CROSS_LOCATION_TRANSFER"
  | "MANUAL_CORRECTION";

export type DwCodeLocationConfig = {
  prefix: string;
  sequenceDigits: number;
  separator: string;
  suffix: string;
};

/** Pure formatting — no DB access. Never let admins supply an arbitrary script/expression (mission section 5). */
export function formatDwCode(config: DwCodeLocationConfig, sequenceNumber: number): string {
  const padded = String(sequenceNumber).padStart(config.sequenceDigits, "0");
  return `${config.prefix}${padded}${config.separator}${config.suffix}`;
}

/** Preview for the admin config screen — does NOT consume a sequence number. */
export function previewDwCode(config: DwCodeLocationConfig, startNumber: number): string {
  return formatDwCode(config, startNumber);
}

export type AllocateDwCodeInput = {
  locationId: string;
  workerId: string;
  employmentSessionId: string;
  dwDataId: string;
  assignedBy: string;
};

export type AllocateDwCodeResult =
  | { ok: true; code: string; codeId: string; reused: boolean }
  | { ok: false; error: "LOCATION_NOT_FOUND" | "LOCATION_INACTIVE" | "WORKER_ALREADY_HAS_ACTIVE_CODE" };

/**
 * Assigns a DW Code to a worker's employment session, reusing a released
 * code before generating a new sequence number (section 49). Race-safe:
 * the "find a reusable code" query uses `FOR UPDATE SKIP LOCKED` (never
 * blocks concurrent allocations on other rows) and new-sequence
 * generation is a single `UPDATE ... RETURNING` on the location's own
 * counter row — Postgres row-level locking makes this correct under
 * concurrency without `MAX(code)+1` or an application-level mutex
 * (mission section 6).
 */
export async function allocateDwCode(input: AllocateDwCodeInput, executor: Executor = db): Promise<AllocateDwCodeResult> {
  if (executor === db) return db.transaction((tx) => allocateDwCode(input, tx));
  const tx = executor;
  {
    const [location] = await tx.select().from(dwCodeLocations).where(eq(dwCodeLocations.id, input.locationId)).limit(1);
    if (!location) return { ok: false, error: "LOCATION_NOT_FOUND" as const };
    if (!location.isActive) return { ok: false, error: "LOCATION_INACTIVE" as const };

    const [existingActive] = await tx
      .select({ id: dwCodeAssignments.id })
      .from(dwCodeAssignments)
      .where(and(eq(dwCodeAssignments.workerId, input.workerId), isNull(dwCodeAssignments.releasedAt)))
      .limit(1);
    if (existingActive) return { ok: false, error: "WORKER_ALREADY_HAS_ACTIVE_CODE" as const };

    const config: DwCodeLocationConfig = {
      prefix: location.prefix,
      sequenceDigits: location.sequenceDigits,
      separator: location.separator,
      suffix: location.suffix,
    };

    const [reusable] = await tx
      .select()
      .from(dwCodes)
      .where(and(eq(dwCodes.locationId, input.locationId), eq(dwCodes.status, "AVAILABLE")))
      .orderBy(asc(dwCodes.sequenceNumber))
      .limit(1)
      .for("update", { skipLocked: true });

    let codeId: string;
    let code: string;
    let reused: boolean;

    if (reusable) {
      await tx.update(dwCodes).set({ status: "ASSIGNED" }).where(eq(dwCodes.id, reusable.id));
      codeId = reusable.id;
      code = reusable.code;
      reused = true;
    } else {
      const [{ usedSequence }] = await tx
        .update(dwCodeLocations)
        .set({ nextSequence: sql`${dwCodeLocations.nextSequence} + 1`, updatedAt: new Date() })
        .where(eq(dwCodeLocations.id, input.locationId))
        .returning({ usedSequence: sql<number>`${dwCodeLocations.nextSequence} - 1` });
      code = formatDwCode(config, usedSequence);
      const [created] = await tx
        .insert(dwCodes)
        .values({ locationId: input.locationId, sequenceNumber: usedSequence, code, status: "ASSIGNED" })
        .returning({ id: dwCodes.id });
      codeId = created.id;
      reused = false;
    }

    await tx.insert(dwCodeAssignments).values({
      codeId,
      workerId: input.workerId,
      employmentSessionId: input.employmentSessionId,
      dwDataId: input.dwDataId,
      assignedBy: input.assignedBy,
    });

    await tx
      .update(dwData)
      .set({ code, dailyCodeUpdatedAt: new Date(), dailyCodeUpdatedBy: input.assignedBy })
      .where(eq(dwData.id, input.dwDataId));

    return { ok: true, code, codeId, reused };
  }
}

export type ReleaseDwCodeInput = {
  employmentSessionId: string;
  releasedBy: string;
  releaseReason: ReleaseReason;
  note?: string | null;
};

export type ReleaseDwCodeResult = { released: boolean; code: string | null };

/**
 * Releases the ACTIVE DW Code assignment for an employment session, if
 * any — makes the code immediately AVAILABLE for reuse and clears the
 * `dw_data.code` mirror. Idempotent: calling this when no active
 * assignment exists (already released, or never had one) is a safe no-op
 * (mission section 46) — never an error.
 */
export async function releaseDwCode(input: ReleaseDwCodeInput, executor: Executor = db): Promise<ReleaseDwCodeResult> {
  if (executor === db) return db.transaction((tx) => releaseDwCode(input, tx));
  const tx = executor;
  {
    const [active] = await tx
      .select({ id: dwCodeAssignments.id, codeId: dwCodeAssignments.codeId, dwDataId: dwCodeAssignments.dwDataId })
      .from(dwCodeAssignments)
      .where(and(eq(dwCodeAssignments.employmentSessionId, input.employmentSessionId), isNull(dwCodeAssignments.releasedAt)))
      .limit(1);
    if (!active) return { released: false, code: null };

    await tx
      .update(dwCodeAssignments)
      .set({ releasedAt: new Date(), releasedBy: input.releasedBy, releaseReason: input.releaseReason, note: input.note ?? null })
      .where(eq(dwCodeAssignments.id, active.id));

    const [code] = await tx
      .update(dwCodes)
      .set({ status: "AVAILABLE" })
      .where(eq(dwCodes.id, active.codeId))
      .returning({ code: dwCodes.code });

    await tx
      .update(dwData)
      .set({ code: null, dailyCodeUpdatedAt: new Date(), dailyCodeUpdatedBy: input.releasedBy })
      .where(eq(dwData.id, active.dwDataId));

    return { released: true, code: code?.code ?? null };
  }
}

export type DwCodePoolStatus = {
  locationId: string;
  prefix: string;
  available: number;
  assigned: number;
  retired: number;
  nextSequence: number;
};

/** Section 48 — code pool status per location, for staff visibility (never require typing the next code manually). */
export async function getDwCodePoolStatus(locationId: string): Promise<DwCodePoolStatus | null> {
  const [location] = await db.select().from(dwCodeLocations).where(eq(dwCodeLocations.id, locationId)).limit(1);
  if (!location) return null;

  const rows = await db
    .select({ status: dwCodes.status, count: sql<number>`count(*)::int` })
    .from(dwCodes)
    .where(eq(dwCodes.locationId, locationId))
    .groupBy(dwCodes.status);

  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  return {
    locationId,
    prefix: location.prefix,
    available: byStatus.AVAILABLE ?? 0,
    assigned: byStatus.ASSIGNED ?? 0,
    retired: byStatus.RETIRED ?? 0,
    nextSequence: location.nextSequence,
  };
}
