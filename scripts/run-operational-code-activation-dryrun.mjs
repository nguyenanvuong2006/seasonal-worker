#!/usr/bin/env node
/**
 * OPERATIONAL CODE GO-LIVE — PRODUCTION DRY-RUN ACTIVATION PLAN (READ-ONLY)
 * ------------------------------------------------------------
 * Mission F2 section 17/18/28. Runs the EXACT SAME plan-assembly logic as
 * `prepareOperationalCodeActivation()` (src/lib/operational-code-activation.ts),
 * via the pure `buildActivationPlan()` (src/lib/operational-code-activation-plan.ts,
 * which has no "server-only"/"@/db" import so it's safe to load outside
 * Next.js — see that file's own docblock), against Production through a
 * plain `pg` client instead of the app's lazy Drizzle client.
 *
 * READ-ONLY: only SELECT statements are issued. No table is created,
 * altered, or written. Never prints CCCD/phone/full name — only opaque
 * worker_profiles.id references, codes, and aggregate counts.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node --import tsx scripts/run-operational-code-activation-dryrun.mjs
 *   node --import tsx scripts/run-operational-code-activation-dryrun.mjs   # reads .env.local
 */
import { config } from "dotenv";
import pg from "pg";
import { buildActivationPlan } from "../src/lib/operational-code-activation-plan.ts";

config({ path: ".env.local" });
config();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Thiếu DATABASE_URL (đặt trong .env.local hoặc biến môi trường).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });

async function main() {
  await client.connect();
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "(không parse được host)";
    }
  })();
  console.log(`✅ Kết nối DB: host=${host}`);
  console.log("ℹ️  READ-ONLY — chỉ SELECT, không ghi bất kỳ dòng nào. Không có adoption/activation nào được thực hiện.\n");

  const locationsResult = await client.query(`SELECT id AS location_id, prefix, name, is_active, next_sequence FROM dw_code_locations`);
  const locations = locationsResult.rows.map((r) => ({ locationId: r.location_id, prefix: r.prefix, name: r.name, isActive: r.is_active, nextSequence: r.next_sequence }));

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
  const dwRows = dwResult.rows.map((r) => ({ dwDataId: r.dw_data_id, workerRef: r.worker_ref, employmentSessionId: r.employment_session_id, code: r.code, isActive: r.is_active }));

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
  const itRows = itResult.rows.map((r) => ({ workerRef: r.worker_ref, dwDataId: r.dw_data_id, employmentSessionId: r.employment_session_id, dwDataItCode: r.dw_it_code, workerProfileFingerprintCode: r.wp_fingerprint_code, isActive: r.is_active }));

  const plan = buildActivationPlan({
    generatedAt: new Date().toISOString(),
    sourceCommitSha: process.env.APP_COMMIT_SHA ?? null,
    locations,
    dwRows,
    itRows,
  });

  console.log("=== ACTIVATION DRY-RUN PLAN (aggregate summary — no PII) ===\n");
  console.log(`version: ${plan.version}`);
  console.log(`generatedAt: ${plan.generatedAt}`);
  console.log(`sourceCommitSha: ${plan.sourceCommitSha ?? "(not set)"}`);
  console.log(`checksum: ${plan.checksum}`);
  console.log(`activationContentChecksum: ${plan.activationContentChecksum}`);
  console.log(`readiness: ${plan.readiness}\n`);

  console.log(`Location readiness (${plan.locationReadiness.length} configured location(s)):`);
  for (const r of plan.locationReadiness) {
    console.log(`  - ${r.prefix} (${r.name}): state=${r.state} nextSequence=${r.nextSequence} legacyObservedMax=${r.legacyObservedMaxSequence ?? "n/a"}`);
  }

  console.log(`\nDW adoption candidates (ACTIVE worker, ready location): ${plan.dwAdoptions.length}`);
  console.log(`DW protected legacy codes (not provably active, never AVAILABLE): ${plan.dwProtectedCodes.length}`);
  console.log(`IT adoption candidates (CONSISTENT mirrors, ACTIVE worker): ${plan.itAdoptions.length}`);

  console.log(`\nConflicts (${plan.conflicts.length}) — BLOCKERS, nothing auto-repaired:`);
  const byType = new Map();
  for (const c of plan.conflicts) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  for (const [type, n] of byType) console.log(`  - ${type}: ${n}`);
  if (plan.conflicts.length > 0) {
    console.log("\nDetail (opaque worker references only, never CCCD/phone/name):");
    for (const c of plan.conflicts) console.log(`  [${c.type}] ${c.detail} workerRefs=${JSON.stringify(c.workerRefs)}`);
  }

  console.log(`\n=== KẾT LUẬN: ${plan.readiness} ===`);
}

main()
  .catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end();
  });
