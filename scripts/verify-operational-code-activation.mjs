#!/usr/bin/env node
/**
 * OPERATIONAL CODE PRODUCTION POST-ACTIVATION VERIFICATION (READ-ONLY)
 * -------------------------------------------------------------------
 * Strictly read-only verification step executed after operational-code
 * activation on Production.
 *
 * Verifies at minimum:
 * 1. Fresh dry-run activation plan still has conflicts = 0.
 * 2. dw_codes canonical pool is now populated (row count > 0).
 * 3. Active DW canonical assignments exist (released_at IS NULL > 0).
 * 4. Protected legacy DW codes are NOT in AVAILABLE status (never available for re-issue).
 * 5. No DW code has >1 active worker (zero duplicate active assignments).
 * 6. No IT code has >1 active worker (zero duplicate active IT assignments).
 * 7. Location 'DR' next_sequence is >= 50002 (safe monotonically bumped sequence).
 *
 * Strictly issues SELECT queries only — never modifies data.
 * Never prints PII (no CCCD, phone, full name, or raw worker IDs).
 * Exits non-zero on any verification failure.
 */
import { config } from "dotenv";
import pg from "pg";
import { buildActivationPlan } from "../src/lib/operational-code-activation-plan.ts";

config({ path: ".env.local" });
config();

/**
 * Executes post-activation read-only verification queries against client.
 */
export async function verifyOperationalCodeActivation(options = {}) {
  const client = options.client;
  if (!client) {
    throw new Error("verifyOperationalCodeActivation: client is required.");
  }

  const results = {
    conflictsZero: false,
    poolPopulated: false,
    dwActiveAssignmentsExist: false,
    protectedCodesNotAvailable: false,
    noDuplicateDwActive: false,
    noDuplicateItActive: false,
    drNextSequenceSafe: false,
    details: {},
  };

  // 1. Fresh plan re-query & conflict check
  const locationsResult = await client.query(`
    SELECT id AS location_id, prefix, name, is_active, next_sequence FROM dw_code_locations
  `);
  const locations = locationsResult.rows.map((r) => ({
    locationId: r.location_id,
    prefix: r.prefix,
    name: r.name,
    isActive: r.is_active,
    nextSequence: r.next_sequence,
  }));

  const dwResult = await client.query(`
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
  const dwRows = dwResult.rows.map((r) => ({
    dwDataId: r.dw_data_id,
    workerRef: r.worker_ref,
    employmentSessionId: r.employment_session_id,
    code: r.code,
    isActive: r.is_active,
  }));

  const itResult = await client.query(`
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
  const itRows = itResult.rows.map((r) => ({
    workerRef: r.worker_ref,
    dwDataId: r.dw_data_id,
    employmentSessionId: r.employment_session_id,
    dwDataItCode: r.dw_it_code,
    workerProfileFingerprintCode: r.wp_fingerprint_code,
    isActive: r.is_active,
  }));

  const plan = buildActivationPlan({
    generatedAt: new Date().toISOString(),
    sourceCommitSha: options.commitSha ?? process.env.APP_COMMIT_SHA ?? null,
    locations,
    dwRows,
    itRows,
  });

  results.conflictsZero = plan.conflicts.length === 0;
  results.details.conflictsCount = plan.conflicts.length;
  if (!results.conflictsZero) {
    throw new Error(`VERIFICATION_FAILED: Plan has ${plan.conflicts.length} conflict(s). Expected 0.`);
  }

  // 2. dw_codes canonical pool populated
  const dwCodesCountRes = await client.query(`SELECT count(*)::int AS count FROM dw_codes`);
  const dwCodesCount = Number(dwCodesCountRes.rows[0]?.count ?? 0);
  results.poolPopulated = dwCodesCount > 0;
  results.details.dwCodesCount = dwCodesCount;
  if (!results.poolPopulated) {
    throw new Error(`VERIFICATION_FAILED: dw_codes table is empty (0 rows). Expected canonical pool to be populated.`);
  }

  // 3. active DW canonical assignments exist
  const dwAssignmentsCountRes = await client.query(`
    SELECT count(*)::int AS count FROM dw_code_assignments WHERE released_at IS NULL
  `);
  const dwActiveAssignmentsCount = Number(dwAssignmentsCountRes.rows[0]?.count ?? 0);
  results.dwActiveAssignmentsExist = dwActiveAssignmentsCount > 0;
  results.details.dwActiveAssignmentsCount = dwActiveAssignmentsCount;
  if (!results.dwActiveAssignmentsExist) {
    throw new Error(`VERIFICATION_FAILED: No active DW canonical assignments found in dw_code_assignments.`);
  }

  // 4. protected legacy codes are NOT AVAILABLE
  const protectedCodesList = plan.dwProtectedCodes.map((p) => p.code);
  let availableProtectedCount = 0;
  if (protectedCodesList.length > 0) {
    const availableProtectedRes = await client.query(
      `SELECT count(*)::int AS count FROM dw_codes WHERE status = 'AVAILABLE' AND code = ANY($1::text[])`,
      [protectedCodesList]
    );
    availableProtectedCount = Number(availableProtectedRes.rows[0]?.count ?? 0);
  }
  results.protectedCodesNotAvailable = availableProtectedCount === 0;
  results.details.availableProtectedCount = availableProtectedCount;
  results.details.totalProtectedCodes = protectedCodesList.length;
  if (!results.protectedCodesNotAvailable) {
    throw new Error(
      `VERIFICATION_FAILED: ${availableProtectedCount} protected legacy DW code(s) have status='AVAILABLE'. Protected codes must NEVER be AVAILABLE.`
    );
  }

  // 5. no DW code has >1 active worker
  const duplicateDwRes = await client.query(`
    SELECT code_id, count(*)::int AS active_count
    FROM dw_code_assignments
    WHERE released_at IS NULL
    GROUP BY code_id
    HAVING count(*) > 1
  `);
  results.noDuplicateDwActive = duplicateDwRes.rows.length === 0;
  results.details.duplicateActiveDwCodes = duplicateDwRes.rows.length;
  if (!results.noDuplicateDwActive) {
    throw new Error(
      `VERIFICATION_FAILED: ${duplicateDwRes.rows.length} DW code(s) are assigned to multiple active workers simultaneously.`
    );
  }

  // 6. no IT code has >1 active worker
  const duplicateItRes = await client.query(`
    SELECT it_code, count(*)::int AS active_count
    FROM it_code_assignments
    WHERE released_at IS NULL
    GROUP BY it_code
    HAVING count(*) > 1
  `);
  results.noDuplicateItActive = duplicateItRes.rows.length === 0;
  results.details.duplicateActiveItCodes = duplicateItRes.rows.length;
  if (!results.noDuplicateItActive) {
    throw new Error(
      `VERIFICATION_FAILED: ${duplicateItRes.rows.length} IT code(s) are assigned to multiple active workers simultaneously.`
    );
  }

  // 7. DR nextSequence >= 50002
  const drLocation = locations.find((l) => l.prefix === "DR");
  const drNextSeq = drLocation ? Number(drLocation.nextSequence) : 0;
  results.drNextSequenceSafe = drNextSeq >= 50002;
  results.details.drNextSequence = drNextSeq;
  if (!results.drNextSequenceSafe) {
    throw new Error(
      `VERIFICATION_FAILED: Location 'DR' next_sequence is ${drNextSeq}. Expected >= 50002.`
    );
  }

  return results;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ Thiếu DATABASE_URL (đặt trong .env.local hoặc biến môi trường).");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "(unparseable)";
      }
    })();

    console.log("============================================================");
    console.log(" POST-ACTIVATION VERIFICATION — PRODUCTION (READ-ONLY)");
    console.log("============================================================");
    console.log(`DB Host:                   ${host}`);
    console.log("Verification Mode:         READ-ONLY (SELECT queries only)");
    console.log("PII Policy:                STRICT — Zero PII displayed in logs");
    console.log("============================================================\n");

    const verification = await verifyOperationalCodeActivation({ client });

    console.log("============================================================");
    console.log(" ✅ ALL 7 POST-ACTIVATION INVARIANTS VERIFIED SUCCESSFULLY");
    console.log("============================================================");
    console.log(`1. Plan Conflicts:         ${verification.details.conflictsCount} (Expected: 0)`);
    console.log(`2. dw_codes Pool Rows:     ${verification.details.dwCodesCount} (Expected: > 0)`);
    console.log(`3. Active DW Assignments:  ${verification.details.dwActiveAssignmentsCount} (Expected: > 0)`);
    console.log(`4. Available Protected:    ${verification.details.availableProtectedCount} / ${verification.details.totalProtectedCodes} (Expected: 0)`);
    console.log(`5. Duplicate Active DW:    ${verification.details.duplicateActiveDwCodes} (Expected: 0)`);
    console.log(`6. Duplicate Active IT:    ${verification.details.duplicateActiveItCodes} (Expected: 0)`);
    console.log(`7. DR next_sequence:       ${verification.details.drNextSequence} (Expected: >= 50002)`);
    console.log("============================================================\n");
  } finally {
    await client.end();
  }
}

// Execute when invoked directly via node CLI
const isDirectRun = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith("verify-operational-code-activation.mjs") ||
   process.argv[1].endsWith("verify-operational-code-activation"))
);

if (isDirectRun) {
  main().catch((err) => {
    console.error(`\n❌ POST-ACTIVATION VERIFICATION FAILED: ${err?.message || err}`);
    process.exit(1);
  });
}
