import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * MISSION F — OPERATIONAL CODE GO-LIVE PREPARATION (sections 3, 9-12, 23-26).
 * ------------------------------------------------------------------------
 * READ-ONLY dry-run planner. `prepareOperationalCodeActivation()` never
 * writes anything — it computes what an eventual adoption/activation WOULD
 * do, so an owner can review the plan (and its checksum) before any real
 * Production write happens.
 *
 * `applyOperationalCodeActivation()` is DELIBERATELY NOT IMPLEMENTED in this
 * mission (section 25: "Design but DO NOT execute" / "ACTIVATION WRITE MUST
 * BE SEPARATE") — it always throws. Its required contract (advisory lock,
 * planChecksum freshness check, re-check conflicts, staged transaction,
 * idempotent, audit) is documented on the function below so a FUTURE,
 * explicitly-authorized mission can implement it against this same plan
 * shape without re-deriving the contract. This mission's own ABSOLUTE
 * SAFETY section forbids any Production DW/IT code assignment or release —
 * an unreachable-but-designed function is the correct scope, not a
 * real-but-never-called one (nothing in this codebase wires it to any
 * route/button, so it cannot be triggered even accidentally).
 *
 * BOOTSTRAP SAFETY (section 3, the P1 this whole planner exists for): the
 * canonical pool (dw_codes/dw_code_assignments) starts EMPTY. Every DW Code
 * a worker holds today came from the legacy free-text `dw_data.code` field
 * (see src/app/api/administration/daily-code/route.ts), completely
 * unknown to allocateDwCode()'s reuse/sequence logic. Activating the pool
 * allocator for a location whose `nextSequence` is still at its schema
 * default (1) while legacy codes like DR00001-D..DR01482-D are already in
 * active use would let `allocateDwCode()` issue DR00001-D again — this
 * planner's `locationReadiness[].state` (`SEQUENCE_UNSAFE`) and the
 * companion fail-closed guard in dw-code-locations-admin.ts's
 * `createDwCodeLocation()` (mission section 41 fix) are what actually
 * prevent that, not merely report it.
 */

/* ============================================================
   PURE HELPERS — no DB access, fully unit-testable in isolation
   ============================================================ */

export type ParsedDwCode = { prefix: string; sequence: number; separator: string; suffix: string };

/** Same shape formatDwCode() (dw-code-pool.ts) produces: PREFIX + zero-padded digits + separator + suffix.
 * Legacy codes were free-typed, never validated by validateDwCodeLocationInput() — anything that doesn't
 * match is UNRECOGNIZED_FORMAT (returns null), never guessed/coerced (mission section 5/8). */
const DW_CODE_RE = /^([A-Z]{1,8})(\d{1,10})([-_]?)([A-Z0-9]{0,8})$/;

export function parseDwCodeFormat(code: string): ParsedDwCode | null {
  const m = DW_CODE_RE.exec(code.trim().toUpperCase());
  if (!m) return null;
  return { prefix: m[1], sequence: Number(m[2]), separator: m[3], suffix: m[4] };
}

/** Section 7 — never start at 1, never reuse historical gaps: the minimum SAFE nextSequence for a
 * prefix is strictly above the highest sequence number ever observed for it, full stop. */
export function computeSafeNextSequence(observedMaxSequence: number | null): number {
  if (observedMaxSequence === null) return 1;
  return observedMaxSequence + 1;
}

export type MirrorConsistency = "CONSISTENT" | "MISSING_MIRROR" | "CONFLICTING_VALUES" | "NO_IT_CODE";

/** Section 12 — dw_data.it_code vs worker_profiles.fingerprint_code (the two mirrors this planner
 * can actually adopt from; daily_applications.it_code is a third mirror the diagnostic script
 * reports on but is per-registration, not per-worker, so it is not part of the adoption decision). */
export function classifyMirrorConsistency(dwDataItCode: string | null, workerProfileFingerprintCode: string | null): MirrorConsistency {
  const a = dwDataItCode?.trim() || null;
  const b = workerProfileFingerprintCode?.trim() || null;
  if (!a && !b) return "NO_IT_CODE";
  if (a && b) return a === b ? "CONSISTENT" : "CONFLICTING_VALUES";
  return "MISSING_MIRROR";
}

export type LocationReadinessState = "READY" | "MISSING_CONFIG" | "SEQUENCE_UNSAFE" | "INACTIVE" | "UNKNOWN_EXISTING_PREFIX";

export type LocationRow = { locationId: string; prefix: string; name: string; isActive: boolean; nextSequence: number };

export type LocationReadiness = {
  locationId: string;
  prefix: string;
  name: string;
  isActive: boolean;
  nextSequence: number;
  legacyObservedMaxSequence: number | null;
  state: LocationReadinessState;
};

/** Section 19 — one readiness verdict per EXISTING dw_code_locations row. `PREFIX_CONFLICT` is
 * intentionally absent here: `dw_code_location_prefix_uq` (a real unique index in the deployed
 * migration) already makes two active locations sharing a prefix structurally impossible at the
 * DB level (section 20's own answer) — nothing to detect at plan time. */
export function evaluateLocationReadiness(location: LocationRow, legacyObservedMaxSequence: number | null): LocationReadiness {
  let state: LocationReadinessState;
  if (!location.isActive) state = "INACTIVE";
  else if (legacyObservedMaxSequence !== null && location.nextSequence <= legacyObservedMaxSequence) state = "SEQUENCE_UNSAFE";
  else state = "READY";
  return { locationId: location.locationId, prefix: location.prefix, name: location.name, isActive: location.isActive, nextSequence: location.nextSequence, legacyObservedMaxSequence, state };
}

/* ============================================================
   PLAN ASSEMBLY — pure given raw rows (unit-testable without a DB)
   ============================================================ */

export type DwLegacyRow = { dwDataId: string; workerRef: string | null; employmentSessionId: string | null; code: string; isActive: boolean };
export type ItMirrorRow = { workerRef: string; dwDataId: string | null; employmentSessionId: string | null; dwDataItCode: string | null; workerProfileFingerprintCode: string | null; isActive: boolean };

export type DwAdoptionCandidate = { workerRef: string; employmentSessionId: string; dwDataId: string; code: string; locationId: string; sequenceNumber: number };
export type DwProtectedCode = { code: string; prefix: string; locationId: string; sequenceNumber: number };
export type ItAdoptionCandidate = { workerRef: string; employmentSessionId: string; dwDataId: string; itCode: string };

export type ActivationConflictType =
  | "DW_CODE_DUPLICATE_ACTIVE_WORKERS"
  | "DW_WORKER_MULTIPLE_ACTIVE_CODES"
  | "DW_LOCATION_NOT_READY"
  | "DW_UNRECOGNIZED_FORMAT"
  | "IT_CODE_DUPLICATE_ACTIVE_WORKERS"
  | "IT_MIRROR_CONFLICT";

export type ActivationConflict = { type: ActivationConflictType; detail: string; workerRefs: string[] };

export type ActivationPlan = {
  version: 1;
  generatedAt: string;
  sourceCommitSha: string | null;
  locationReadiness: LocationReadiness[];
  dwAdoptions: DwAdoptionCandidate[];
  dwProtectedCodes: DwProtectedCode[];
  itAdoptions: ItAdoptionCandidate[];
  conflicts: ActivationConflict[];
  readiness: "READY_FOR_OPERATIONAL_CODE_ACTIVATION" | "BLOCKED";
  checksum: string;
};

/** Deterministic JSON — array/object key order is fixed by how this file always constructs the
 * plan, so the checksum is stable across runs against identical underlying data (mission section 24). */
function computeChecksum(planWithoutChecksum: Omit<ActivationPlan, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(planWithoutChecksum)).digest("hex");
}

/**
 * Pure plan assembly — takes already-fetched rows (never touches the DB itself) so it can be
 * exhaustively unit-tested. `prepareOperationalCodeActivation()` below is the thin DB-fetching
 * wrapper around this.
 */
export function buildActivationPlan(input: {
  generatedAt: string;
  sourceCommitSha: string | null;
  locations: LocationRow[];
  dwRows: DwLegacyRow[];
  itRows: ItMirrorRow[];
}): ActivationPlan {
  const conflicts: ActivationConflict[] = [];

  // ---- DW Code: per-prefix legacy max sequence (section 7) ----
  const maxSeqByPrefix = new Map<string, number>();
  const dwByPrefix = new Map<string, DwLegacyRow[]>();
  const unrecognizedDwCodes: string[] = [];
  for (const row of input.dwRows) {
    const parsed = parseDwCodeFormat(row.code);
    if (!parsed) {
      unrecognizedDwCodes.push(row.code);
      continue;
    }
    maxSeqByPrefix.set(parsed.prefix, Math.max(maxSeqByPrefix.get(parsed.prefix) ?? -Infinity, parsed.sequence));
    const bucket = dwByPrefix.get(parsed.prefix) ?? [];
    bucket.push(row);
    dwByPrefix.set(parsed.prefix, bucket);
  }
  if (unrecognizedDwCodes.length > 0) {
    conflicts.push({ type: "DW_UNRECOGNIZED_FORMAT", detail: `${unrecognizedDwCodes.length} legacy dw_data.code value(s) do not match the PREFIX+SEQUENCE[+separator][+suffix] shape — cannot be classified or adopted automatically.`, workerRefs: [] });
  }

  const locationReadiness = input.locations.map((loc) => evaluateLocationReadiness(loc, maxSeqByPrefix.has(loc.prefix) ? (maxSeqByPrefix.get(loc.prefix) as number) : null));
  const locationByPrefix = new Map(input.locations.map((l) => [l.prefix, l]));
  const readinessByLocationId = new Map(locationReadiness.map((r) => [r.locationId, r]));

  for (const prefix of maxSeqByPrefix.keys()) {
    if (!locationByPrefix.has(prefix)) {
      conflicts.push({ type: "DW_LOCATION_NOT_READY", detail: `LOCATION_PREFIX_MAPPING_REQUIRED — prefix "${prefix}" appears in legacy dw_data.code but has no dw_code_locations config yet.`, workerRefs: [] });
    }
  }

  // ---- DW Code adoption candidates + protected legacy codes ----
  const dwAdoptions: DwAdoptionCandidate[] = [];
  const dwProtectedCodes: DwProtectedCode[] = [];
  const blockedWorkerRefs = new Set<string>();

  // Same code, multiple ACTIVE workers -> hard blocker for every worker involved (section 35).
  const activeWorkersByCode = new Map<string, Set<string>>();
  for (const row of input.dwRows) {
    if (!row.isActive || !row.workerRef) continue;
    const set = activeWorkersByCode.get(row.code) ?? new Set<string>();
    set.add(row.workerRef);
    activeWorkersByCode.set(row.code, set);
  }
  for (const [code, workers] of activeWorkersByCode) {
    if (workers.size > 1) {
      conflicts.push({ type: "DW_CODE_DUPLICATE_ACTIVE_WORKERS", detail: `DW Code "${code}" is held by ${workers.size} workers with an ACTIVE employment session simultaneously.`, workerRefs: [...workers] });
      for (const w of workers) blockedWorkerRefs.add(w);
    }
  }

  // One ACTIVE worker, multiple distinct current codes -> hard blocker (section 35 sibling case).
  const activeCodesByWorker = new Map<string, Set<string>>();
  for (const row of input.dwRows) {
    if (!row.isActive || !row.workerRef) continue;
    const set = activeCodesByWorker.get(row.workerRef) ?? new Set<string>();
    set.add(row.code);
    activeCodesByWorker.set(row.workerRef, set);
  }
  for (const [workerRef, codes] of activeCodesByWorker) {
    if (codes.size > 1) {
      conflicts.push({ type: "DW_WORKER_MULTIPLE_ACTIVE_CODES", detail: `Worker holds ${codes.size} conflicting DW Codes across dw_data rows: ${[...codes].join(", ")}.`, workerRefs: [workerRef] });
      blockedWorkerRefs.add(workerRef);
    }
  }

  for (const row of input.dwRows) {
    const parsed = parseDwCodeFormat(row.code);
    if (!parsed) continue; // already reported as DW_UNRECOGNIZED_FORMAT above
    const location = locationByPrefix.get(parsed.prefix);
    const readiness = location ? readinessByLocationId.get(location.locationId) : undefined;

    if (row.isActive && row.workerRef && row.employmentSessionId) {
      if (blockedWorkerRefs.has(row.workerRef)) continue;
      if (!location || readiness?.state !== "READY") continue; // reported via DW_LOCATION_NOT_READY / SEQUENCE_UNSAFE / INACTIVE already
      dwAdoptions.push({ workerRef: row.workerRef, employmentSessionId: row.employmentSessionId, dwDataId: row.dwDataId, code: row.code, locationId: location.locationId, sequenceNumber: parsed.sequence });
    } else if (location) {
      // LEGACY_OBSERVED, not provably active — protect, never AVAILABLE (mission section 8).
      dwProtectedCodes.push({ code: row.code, prefix: parsed.prefix, locationId: location.locationId, sequenceNumber: parsed.sequence });
    }
  }

  // ---- IT Code adoption candidates ----
  const itAdoptions: ItAdoptionCandidate[] = [];
  const activeItWorkersByCode = new Map<string, Set<string>>();
  for (const row of input.itRows) {
    if (!row.isActive) continue;
    const consistency = classifyMirrorConsistency(row.dwDataItCode, row.workerProfileFingerprintCode);
    if (consistency !== "CONSISTENT") continue;
    const code = (row.workerProfileFingerprintCode as string).trim();
    const set = activeItWorkersByCode.get(code) ?? new Set<string>();
    set.add(row.workerRef);
    activeItWorkersByCode.set(code, set);
  }
  const blockedItWorkerRefs = new Set<string>();
  for (const [code, workers] of activeItWorkersByCode) {
    if (workers.size > 1) {
      conflicts.push({ type: "IT_CODE_DUPLICATE_ACTIVE_WORKERS", detail: `IT Code "${code}" is held by ${workers.size} workers with an ACTIVE employment session simultaneously.`, workerRefs: [...workers] });
      for (const w of workers) blockedItWorkerRefs.add(w);
    }
  }

  for (const row of input.itRows) {
    const consistency = classifyMirrorConsistency(row.dwDataItCode, row.workerProfileFingerprintCode);
    if (consistency === "CONFLICTING_VALUES") {
      conflicts.push({ type: "IT_MIRROR_CONFLICT", detail: `dw_data.it_code and worker_profiles.fingerprint_code disagree for this worker ("${row.dwDataItCode}" vs "${row.workerProfileFingerprintCode}").`, workerRefs: [row.workerRef] });
      continue;
    }
    if (consistency !== "CONSISTENT" || !row.isActive || !row.dwDataId || !row.employmentSessionId) continue;
    if (blockedItWorkerRefs.has(row.workerRef)) continue;
    itAdoptions.push({ workerRef: row.workerRef, employmentSessionId: row.employmentSessionId, dwDataId: row.dwDataId, itCode: (row.workerProfileFingerprintCode as string).trim() });
  }

  const readiness: ActivationPlan["readiness"] = conflicts.length === 0 && locationReadiness.every((r) => r.state === "READY" || r.state === "INACTIVE") ? "READY_FOR_OPERATIONAL_CODE_ACTIVATION" : "BLOCKED";

  const withoutChecksum: Omit<ActivationPlan, "checksum"> = {
    version: 1,
    generatedAt: input.generatedAt,
    sourceCommitSha: input.sourceCommitSha,
    locationReadiness,
    dwAdoptions,
    dwProtectedCodes,
    itAdoptions,
    conflicts,
    readiness,
  };
  return { ...withoutChecksum, checksum: computeChecksum(withoutChecksum) };
}

/* ============================================================
   DB-FETCHING WRAPPER — the only part that touches Postgres, and only via SELECT
   ============================================================ */

type Executor = typeof db;

/** dryRun is required and must be true — this function performs ONLY SELECT statements
 * regardless, but the flag is kept explicit in the call site per mission section 9/23
 * ("prepareOperationalCodeActivation({ dryRun: true })") so no future edit can silently
 * turn this into a writer without a visible signature change. */
export async function prepareOperationalCodeActivation(options: { dryRun: true }, executor: Executor = db): Promise<ActivationPlan> {
  if (!options.dryRun) throw new Error("prepareOperationalCodeActivation: dryRun must be true — this function never writes.");

  const locationsResult = await executor.execute<{ location_id: string; prefix: string; name: string; is_active: boolean; next_sequence: number }>(
    sql`SELECT id AS location_id, prefix, name, is_active, next_sequence FROM dw_code_locations`,
  );
  const locations: LocationRow[] = locationsResult.rows.map((r) => ({ locationId: r.location_id, prefix: r.prefix, name: r.name, isActive: r.is_active, nextSequence: r.next_sequence }));

  const dwResult = await executor.execute<{ dw_data_id: string; worker_ref: string | null; employment_session_id: string | null; code: string; is_active: boolean }>(sql`
    SELECT d.id AS dw_data_id, wp.id AS worker_ref, es.id AS employment_session_id, d.code AS code,
           COALESCE(es.status = 'APPROVED' AND es.end_date IS NULL, false) AS is_active
    FROM dw_data d
    LEFT JOIN worker_profiles wp ON wp.cccd = d.cccd AND wp.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT id, status, end_date FROM employment_sessions
      WHERE worker_id = wp.id
      ORDER BY (status = 'APPROVED' AND end_date IS NULL) DESC, reg_date DESC
      LIMIT 1
    ) es ON true
    WHERE d.code IS NOT NULL AND trim(d.code) <> '' AND d.deleted_at IS NULL
  `);
  const dwRows: DwLegacyRow[] = dwResult.rows.map((r) => ({ dwDataId: r.dw_data_id, workerRef: r.worker_ref, employmentSessionId: r.employment_session_id, code: r.code, isActive: r.is_active }));

  const itResult = await executor.execute<{
    worker_ref: string;
    dw_data_id: string | null;
    employment_session_id: string | null;
    dw_it_code: string | null;
    wp_fingerprint_code: string | null;
    is_active: boolean;
  }>(sql`
    SELECT wp.id AS worker_ref, d.id AS dw_data_id, es.id AS employment_session_id,
           d.it_code AS dw_it_code, wp.fingerprint_code AS wp_fingerprint_code,
           COALESCE(es.status = 'APPROVED' AND es.end_date IS NULL, false) AS is_active
    FROM worker_profiles wp
    LEFT JOIN dw_data d ON d.cccd = wp.cccd AND d.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT id, status, end_date FROM employment_sessions
      WHERE worker_id = wp.id
      ORDER BY (status = 'APPROVED' AND end_date IS NULL) DESC, reg_date DESC
      LIMIT 1
    ) es ON true
    WHERE wp.deleted_at IS NULL AND (wp.fingerprint_code IS NOT NULL OR d.it_code IS NOT NULL)
  `);
  const itRows: ItMirrorRow[] = itResult.rows.map((r) => ({ workerRef: r.worker_ref, dwDataId: r.dw_data_id, employmentSessionId: r.employment_session_id, dwDataItCode: r.dw_it_code, workerProfileFingerprintCode: r.wp_fingerprint_code, isActive: r.is_active }));

  return buildActivationPlan({
    generatedAt: new Date().toISOString(),
    sourceCommitSha: process.env.APP_COMMIT_SHA ?? null,
    locations,
    dwRows,
    itRows,
  });
}

/**
 * NOT IMPLEMENTED (mission section 25 — "Design but DO NOT execute"). Documented contract for a
 * FUTURE, separately-authorized mission:
 *
 *   1. Recompute prepareOperationalCodeActivation({ dryRun: true }) fresh and compare its
 *      `.checksum` to `planChecksum` — mismatch => reject ACTIVATION_PLAN_STALE, do nothing.
 *   2. Reject if the fresh plan has any `conflicts[]` (section 11 — "Do not automatically fix
 *      Production conflicts") or any non-READY/INACTIVE `locationReadiness[]` entry.
 *   3. Take a DEDICATED Postgres advisory lock (a new key, never reused from
 *      DATA_MANAGEMENT_ADVISORY_LOCK_KEY in reset-service.ts — activation and reset are
 *      different risk domains and must never serialize on each other's lock).
 *   4. In one transaction, in the exact order from section 26: (a) INSERT the protected legacy
 *      codes as `dw_codes` rows with status='RETIRED' (ON CONFLICT (code) DO NOTHING — idempotent);
 *      (b) UPDATE each touched `dw_code_locations.next_sequence` to at least
 *      computeSafeNextSequence(legacyObservedMaxSequence); (c) for each `dwAdoptions[]` entry,
 *      INSERT a `dw_codes` ASSIGNED row + a `dw_code_assignments` row (never touch the
 *      `dw_data.code` mirror — it is already correct, this is adoption of EXISTING state, not
 *      reassignment); (d) for each `itAdoptions[]` entry, INSERT an `it_code_assignments` row
 *      (same non-mutation-of-mirrors principle).
 *   5. Release the lock, write ONE audit row summarizing counts (never raw CCCD/phone).
 *   6. Idempotent: re-running with the SAME already-applied plan checksum after a first
 *      successful apply should be a safe no-op (the ON CONFLICT / already-exists checks in step 4
 *      make every sub-operation individually idempotent).
 *
 * This function intentionally throws so it can exist in the codebase (satisfying "code changes"
 * from the mission's ABSOLUTE SAFETY allow-list) without being callable — there is also no
 * route/UI button anywhere in this PR that invokes it.
 */
export async function applyOperationalCodeActivation(_planChecksum: string): Promise<never> {
  throw new Error(
    "applyOperationalCodeActivation: NOT IMPLEMENTED in this mission. Production DW/IT code assignment is not authorized here — see this function's docblock for the required contract for a future, separately-authorized rollout.",
  );
}
