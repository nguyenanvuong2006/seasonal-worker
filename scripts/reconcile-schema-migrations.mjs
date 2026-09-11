#!/usr/bin/env node
/**
 * SCHEMA MIGRATION RECONCILIATION — READ-ONLY (Mission B section 6).
 * ------------------------------------------------------------
 * Cross-references migrations/*.sql, scripts/migration-manifest.mjs, the
 * schema_migrations ledger (if bootstrapped), and live schema evidence to
 * classify every migration file. Performs ONLY SELECT statements — never
 * INSERT/UPDATE/DELETE/DDL. Safe to run against Production at any time.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/reconcile-schema-migrations.mjs
 *   node scripts/reconcile-schema-migrations.mjs   # reads .env.local
 *
 * Exit code is always 0 — this is a diagnostic report, not a gate. Read
 * scripts/production-health-check.mjs for the pass/fail deployment gate.
 */
import { config } from "dotenv";
import pg from "pg";
import { reconcileMigrations } from "./lib/reconciliation.mjs";

config({ path: ".env.local" });
config();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Thiếu DATABASE_URL (đặt trong .env.local hoặc biến môi trường).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });

function printDrift(drift) {
  if (drift.filesWithoutManifestEntry.length === 0 && drift.manifestEntriesWithoutFile.length === 0) {
    console.log("Inventory drift: NONE — migrations/*.sql và scripts/migration-manifest.mjs khớp nhau hoàn toàn.\n");
    return;
  }
  console.log("*** INVENTORY DRIFT DETECTED ***");
  if (drift.filesWithoutManifestEntry.length > 0) {
    console.log("  Files on disk with NO manifest entry:");
    for (const f of drift.filesWithoutManifestEntry) console.log(`    - ${f}`);
  }
  if (drift.manifestEntriesWithoutFile.length > 0) {
    console.log("  Manifest entries with NO matching file on disk:");
    for (const f of drift.manifestEntriesWithoutFile) console.log(`    - ${f}`);
  }
  console.log("");
}

function printReport(report) {
  console.log("\n=== SCHEMA MIGRATION RECONCILIATION (READ-ONLY) ===\n");
  console.log(`Ledger bootstrapped: ${report.ledgerBootstrapped ? "YES" : "NO — LEDGER_NOT_BOOTSTRAPPED"}\n`);
  printDrift(report.drift);

  const counts = {};
  for (const row of report.rows) counts[row.classification] = (counts[row.classification] ?? 0) + 1;

  console.log("| Migration | Ledger | Schema evidence | Classification | Risk |");
  console.log("|---|---|---|---|---|");
  for (const row of report.rows) {
    const evidence = row.structuralEvidence
      ? `${row.structuralEvidence.requiredSatisfied}/${row.structuralEvidence.requiredTotal} present`
      : "n/a";
    console.log(`| ${row.filename} | ${row.ledgerStatus} | ${evidence} | ${row.classification} | ${row.risk} |`);
  }

  console.log("\n--- Summary ---");
  for (const [classification, n] of Object.entries(counts).sort()) {
    console.log(`  ${classification}: ${n}`);
  }

  const critical = report.rows.filter((r) => r.risk === "CRITICAL_APP_DEPENDENCY");
  if (critical.length > 0) {
    console.log("\n--- CRITICAL_APP_DEPENDENCY (P1 attention — do NOT apply without authorization) ---");
    for (const r of critical) console.log(`  [${r.classification}] ${r.filename} — ${r.notes}`);
  }
}

async function main() {
  try {
    await client.connect();
  } catch (err) {
    console.error("Không kết nối được tới DB. Kiểm tra DATABASE_URL / mạng / firewall.");
    process.exit(1);
  }

  try {
    const report = await reconcileMigrations(client, { root: process.cwd() });
    printReport(report);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Lỗi không mong đợi:", err.message);
  process.exit(1);
});
