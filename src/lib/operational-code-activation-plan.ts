import { createHash } from "node:crypto";

/**
 * MISSION F/F2 — pure plan-assembly logic for the operational code go-live planner, split out of
 * operational-code-activation.ts (which carries `import "server-only"` + `@/db`) so this module
 * can be imported by a STANDALONE script (`scripts/run-operational-code-activation-dryrun.mjs`,
 * via `node --import tsx`) without pulling in "server-only" — that package's default export
 * condition (package.json: `"exports"."."."default"` = `index.js`, which unconditionally throws)
 * only resolves to its safe `empty.js` under Next.js's own "react-server" bundling condition,
 * never under plain Node/tsx. Zero DB access, zero Next.js-only imports — fully unit-testable and
 * fully reusable from a CLI script that talks to Postgres directly.
 */

/* ============================================================
   PURE HELPERS
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
  activationContentChecksum: string;
};

/** Deterministic JSON — array/object key order is fixed by how this file always constructs the
 * plan, so the checksum is stable across runs against identical underlying data (mission section 24). */
function computeChecksum(planWithoutChecksum: Omit<ActivationPlan, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(planWithoutChecksum)).digest("hex");
}

export type PlanContentFields = {
  version: 1;
  locationReadiness: LocationReadiness[];
  dwAdoptions: DwAdoptionCandidate[];
  dwProtectedCodes: DwProtectedCode[];
  itAdoptions: ItAdoptionCandidate[];
  conflicts: ActivationConflict[];
  readiness: "READY_FOR_OPERATIONAL_CODE_ACTIVATION" | "BLOCKED";
};

/**
 * Content-only checksum — omits `generatedAt` and `sourceCommitSha` (volatile metadata
 * that changes every run) so the hash represents WHAT the plan decided, not WHEN. Used by
 * `applyOperationalCodeActivation` to detect data-state changes between the reviewed dry-run
 * and the moment of activation, without being defeated by the passage of time.
 *
 * Stable fields: version, locationReadiness, dwAdoptions, dwProtectedCodes, itAdoptions,
 * conflicts, readiness (the fields that determine WHAT would be written — mission section 26).
 */
export function computePlanContentChecksum(plan: PlanContentFields): string {
  const stable = {
    version: plan.version,
    locationReadiness: plan.locationReadiness,
    dwAdoptions: plan.dwAdoptions,
    dwProtectedCodes: plan.dwProtectedCodes,
    itAdoptions: plan.itAdoptions,
    conflicts: plan.conflicts,
    readiness: plan.readiness,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/**
 * Pure plan assembly — takes already-fetched rows (never touches the DB itself) so it can be
 * exhaustively unit-tested AND run from a standalone CLI script. `prepareOperationalCodeActivation()`
 * (operational-code-activation.ts) is the Next.js/Drizzle DB-fetching wrapper around this;
 * `scripts/run-operational-code-activation-dryrun.mjs` is the raw-`pg` CLI wrapper.
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

  const withoutChecksums = {
    version: 1 as const,
    generatedAt: input.generatedAt,
    sourceCommitSha: input.sourceCommitSha,
    locationReadiness,
    dwAdoptions,
    dwProtectedCodes,
    itAdoptions,
    conflicts,
    readiness,
  };
  const activationContentChecksum = computePlanContentChecksum(withoutChecksums);
  const planWithoutChecksum = {
    ...withoutChecksums,
    activationContentChecksum,
  };
  return { ...planWithoutChecksum, checksum: computeChecksum(planWithoutChecksum) };
}
