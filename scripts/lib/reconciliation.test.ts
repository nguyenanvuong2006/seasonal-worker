/**
 * RECONCILIATION ENGINE — unit tests (Mission B section 6/21).
 * Covers: object-ref parsing (present/absent/informational), structural
 * evidence aggregation, classification priority (ledger row wins over
 * everything; tombstoned/superseded when no ledger row; SCHEMA_PRESENT_UNLEDGERED
 * vs NOT_APPLIED_CONFIRMED vs UNKNOWN), and the full reconcileMigrations()
 * pass against a fake client + a real manifest entry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseObjectRef, computeStructuralEvidence, classifyMigration, reconcileMigrations } from "./reconciliation.mjs";
import { getManifestEntry } from "../migration-manifest.mjs";
import { computeChecksum } from "./migration-ledger.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("parseObjectRef: plain structural ref -> expect 'present'", () => {
  const ref = parseObjectRef("column:users.session_version");
  assert.deepEqual(ref, { kind: "column", identifier: "users.session_version", expect: "present", label: "column:users.session_version" });
});

test("parseObjectRef: (DROPPED) suffix -> expect 'absent'", () => {
  const ref = parseObjectRef("index:planning_active_dept_section_uq(DROPPED)");
  assert.equal(ref!.expect, "absent");
  assert.equal(ref!.identifier, "planning_active_dept_section_uq");
});

test("parseObjectRef: (conditional) suffix -> expect 'informational'", () => {
  const ref = parseObjectRef("index:employment_session_one_active_uq(conditional)");
  assert.equal(ref!.expect, "informational");
});

test("parseObjectRef: other descriptive suffixes (type change, GIST, guarded, self-FK) -> still expect 'present'", () => {
  assert.equal(parseObjectRef("column:recruitment_requests.cost(type change numeric->integer)")!.expect, "present");
  assert.equal(parseObjectRef("index:org_units_path_gist_idx(GIST)")!.expect, "present");
  assert.equal(parseObjectRef("constraint:candidate_documents_supersedes_document_id_fkey(self-FK ON DELETE RESTRICT)")!.expect, "present");
});

test("parseObjectRef: non-structural refs (row:/rows:/data:) return null — never probed structurally", () => {
  assert.equal(parseObjectRef("row:branding_settings.id=default"), null);
  assert.equal(parseObjectRef("rows:permissions(~42 keys)"), null);
  assert.equal(parseObjectRef("data:recruitment_requests.male_balance/female_balance/total_balance(recompute all rows)"), null);
});

function makeFakeClient(existsMap: Record<string, boolean>) {
  return {
    async query(text: string, params: unknown[] = []) {
      // Route by which schema-probes.mjs query shape matched, keyed by a
      // caller-supplied lookup key embedded in existsMap.
      let key: string | null = null;
      if (/information_schema\.tables/i.test(text)) key = `table:${params[0]}`;
      else if (/information_schema\.columns/i.test(text)) key = `column:${params[0]}.${params[1]}`;
      else if (/pg_indexes/i.test(text)) key = `index:${params[0]}`;
      else if (/pg_constraint/i.test(text)) key = `constraint:${params[0]}`;
      else if (/pg_proc/i.test(text)) key = `function:${params[0]}`;
      else if (/pg_trigger/i.test(text)) key = `trigger:${params[0]}`;
      else if (/pg_extension/i.test(text)) key = `extension:${params[0]}`;
      else if (/information_schema\.views/i.test(text)) key = `view:${params[0]}`;
      const ok = key !== null && existsMap[key] === true;
      return ok ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
    },
  };
}

test("computeStructuralEvidence: all required objects present -> requiredSatisfied === requiredTotal", async () => {
  const client = makeFakeClient({ "table:foo": true, "index:foo_idx": true });
  const evidence = await computeStructuralEvidence(client, ["table:foo", "index:foo_idx", "rows:foo(seed)"]);
  assert.equal(evidence.requiredTotal, 2);
  assert.equal(evidence.requiredSatisfied, 2);
  assert.equal(evidence.checks.length, 2, "non-structural rows: entry must not appear as a check");
});

test("computeStructuralEvidence: (DROPPED) object correctly absent -> counts as satisfied", async () => {
  const client = makeFakeClient({}); // nothing exists
  const evidence = await computeStructuralEvidence(client, ["index:old_idx(DROPPED)"]);
  assert.equal(evidence.requiredTotal, 1);
  assert.equal(evidence.requiredSatisfied, 1, "a DROPPED object that is genuinely absent must satisfy its check");
});

test("computeStructuralEvidence: (DROPPED) object that STILL exists -> counts as NOT satisfied", async () => {
  const client = makeFakeClient({ "index:old_idx": true });
  const evidence = await computeStructuralEvidence(client, ["index:old_idx(DROPPED)"]);
  assert.equal(evidence.requiredSatisfied, 0);
});

test("computeStructuralEvidence: (conditional) object excluded from requiredTotal regardless of presence", async () => {
  const client = makeFakeClient({});
  const evidence = await computeStructuralEvidence(client, ["index:maybe_idx(conditional)"]);
  assert.equal(evidence.requiredTotal, 0);
  assert.equal(evidence.checks.length, 1, "still probed and reported, just not scored");
});

const BASE_ENTRY = {
  filename: "x.sql",
  category: "SCHEMA_ADDITIVE" as const,
  objectsCreatedOrModified: [],
  idempotent: true,
  transactionSafe: true,
  appDependency: "REQUIRED" as const,
  appDependencyEvidence: "",
  executionMechanism: "MANUAL_PSQL_GENERIC" as const,
  supersededBy: null,
  tombstoned: false,
  tombstonedReason: null,
  requiresBackup: false,
  productionAllowed: true,
  notes: "",
};

test("classifyMigration: ledger row with matching checksum -> APPLIED_CONFIRMED, risk NONE", () => {
  const result = classifyMigration({
    manifestEntry: BASE_ENTRY,
    currentChecksum: "abc",
    ledgerRow: { migration_id: "x.sql", checksum_sha256: "abc", applied_at: new Date(), applied_by: null, execution_method: "TEST", app_commit_sha: null, notes: null },
    structuralEvidence: { checks: [], requiredTotal: 0, requiredSatisfied: 0 },
  });
  assert.deepEqual(result, { classification: "APPLIED_CONFIRMED", risk: "NONE" });
});

test("classifyMigration: ledger row with DIFFERENT checksum -> LEDGER_CHECKSUM_MISMATCH, risk CRITICAL_APP_DEPENDENCY (always, safety-critical)", () => {
  const result = classifyMigration({
    manifestEntry: { ...BASE_ENTRY, appDependency: "NONE" },
    currentChecksum: "abc",
    ledgerRow: { migration_id: "x.sql", checksum_sha256: "different", applied_at: new Date(), applied_by: null, execution_method: "TEST", app_commit_sha: null, notes: null },
    structuralEvidence: { checks: [], requiredTotal: 0, requiredSatisfied: 0 },
  });
  assert.deepEqual(result, { classification: "LEDGER_CHECKSUM_MISMATCH", risk: "CRITICAL_APP_DEPENDENCY" });
});

test("classifyMigration: tombstoned + no ledger row -> TOMBSTONED, even if schema is fully present", () => {
  const result = classifyMigration({
    manifestEntry: { ...BASE_ENTRY, tombstoned: true },
    currentChecksum: "abc",
    ledgerRow: null,
    structuralEvidence: { checks: [], requiredTotal: 3, requiredSatisfied: 3 },
  });
  assert.equal(result.classification, "TOMBSTONED");
  assert.equal(result.risk, "NONE");
});

test("classifyMigration: supersededBy + no ledger row -> SUPERSEDED", () => {
  const result = classifyMigration({
    manifestEntry: { ...BASE_ENTRY, supersededBy: "later.sql" },
    currentChecksum: "abc",
    ledgerRow: null,
    structuralEvidence: { checks: [], requiredTotal: 0, requiredSatisfied: 0 },
  });
  assert.equal(result.classification, "SUPERSEDED");
});

test("classifyMigration: ledger row present WINS over tombstoned/superseded (a ledger row is stronger evidence than manifest metadata)", () => {
  const result = classifyMigration({
    manifestEntry: { ...BASE_ENTRY, tombstoned: true, supersededBy: "later.sql" },
    currentChecksum: "abc",
    ledgerRow: { migration_id: "x.sql", checksum_sha256: "abc", applied_at: new Date(), applied_by: null, execution_method: "HISTORICAL_RECONCILIATION", app_commit_sha: null, notes: null },
    structuralEvidence: { checks: [], requiredTotal: 0, requiredSatisfied: 0 },
  });
  assert.equal(result.classification, "APPLIED_CONFIRMED");
});

test("classifyMigration: no ledger row, zero structural objects (pure data migration) -> UNKNOWN", () => {
  const result = classifyMigration({
    manifestEntry: { ...BASE_ENTRY, appDependency: "NONE" },
    currentChecksum: "abc",
    ledgerRow: null,
    structuralEvidence: { checks: [], requiredTotal: 0, requiredSatisfied: 0 },
  });
  assert.equal(result.classification, "UNKNOWN");
});

test("classifyMigration: no ledger row, ALL structural objects present -> SCHEMA_PRESENT_UNLEDGERED (never auto-APPLIED)", () => {
  const result = classifyMigration({
    manifestEntry: BASE_ENTRY,
    currentChecksum: "abc",
    ledgerRow: null,
    structuralEvidence: { checks: [], requiredTotal: 3, requiredSatisfied: 3 },
  });
  assert.equal(result.classification, "SCHEMA_PRESENT_UNLEDGERED");
  assert.equal(result.risk, "NONE");
});

test("classifyMigration: no ledger row, ZERO structural objects present -> NOT_APPLIED_CONFIRMED", () => {
  const result = classifyMigration({
    manifestEntry: { ...BASE_ENTRY, appDependency: "REQUIRED" },
    currentChecksum: "abc",
    ledgerRow: null,
    structuralEvidence: { checks: [], requiredTotal: 3, requiredSatisfied: 0 },
  });
  assert.equal(result.classification, "NOT_APPLIED_CONFIRMED");
  assert.equal(result.risk, "CRITICAL_APP_DEPENDENCY", "REQUIRED app dependency + confirmed absence = P1");
});

test("classifyMigration: no ledger row, PARTIAL structural evidence -> UNKNOWN (cannot prove either way)", () => {
  const result = classifyMigration({
    manifestEntry: { ...BASE_ENTRY, appDependency: "OPTIONAL" },
    currentChecksum: "abc",
    ledgerRow: null,
    structuralEvidence: { checks: [], requiredTotal: 3, requiredSatisfied: 1 },
  });
  assert.equal(result.classification, "UNKNOWN");
  assert.equal(result.risk, "ACTIVE_FEATURE_DEPENDENCY");
});

test("classifyMigration: risk is LEGACY for UNKNOWN/NOT_APPLIED_CONFIRMED migrations with appDependency NONE", () => {
  const result = classifyMigration({
    manifestEntry: { ...BASE_ENTRY, appDependency: "NONE" },
    currentChecksum: "abc",
    ledgerRow: null,
    structuralEvidence: { checks: [], requiredTotal: 2, requiredSatisfied: 0 },
  });
  assert.equal(result.classification, "NOT_APPLIED_CONFIRMED");
  assert.equal(result.risk, "LEGACY");
});

test("reconcileMigrations: full pass against the REAL manifest + a fake client reporting nothing exists -> ledger absent is reported, zero drift, every row classified", async () => {
  const client = {
    async query(text: string) {
      if (/to_regclass/i.test(text)) return { rows: [{ reg: null }], rowCount: 1 }; // ledger table absent
      return { rows: [], rowCount: 0 }; // nothing else exists either
    },
  };
  const report = await reconcileMigrations(client, { root: process.cwd() });
  assert.equal(report.ledgerBootstrapped, false);
  assert.deepEqual(report.drift.filesWithoutManifestEntry, []);
  assert.deepEqual(report.drift.manifestEntriesWithoutFile, []);
  assert.ok(report.rows.length > 0);
  for (const row of report.rows) {
    assert.equal(row.ledgerStatus, "LEDGER_NOT_BOOTSTRAPPED");
    assert.ok(
      ["TOMBSTONED", "SUPERSEDED", "UNKNOWN", "NOT_APPLIED_CONFIRMED"].includes(row.classification),
      `unexpected classification ${row.classification} for ${row.filename} when nothing exists and no ledger`,
    );
  }
});

test("reconcileMigrations: a real, currently-required migration file with a ledger row of matching checksum reconciles to APPLIED_CONFIRMED", async () => {
  const manifestEntry = getManifestEntry("2026-09-09-ai-action-proposals.sql")!;
  const filePath = join(process.cwd(), "migrations", manifestEntry.filename);
  const checksum = computeChecksum(readFileSync(filePath));

  const client = {
    async query(text: string, params: unknown[] = []) {
      if (/to_regclass/i.test(text)) return { rows: [{ reg: "schema_migrations" }], rowCount: 1 };
      if (/SELECT migration_id, checksum_sha256, applied_at, applied_by, execution_method, app_commit_sha, notes FROM schema_migrations ORDER BY applied_at/i.test(text)) {
        return {
          rows: [{ migration_id: manifestEntry.filename, checksum_sha256: checksum, applied_at: new Date(), applied_by: null, execution_method: "TEST", app_commit_sha: null, notes: null }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const report = await reconcileMigrations(client, { root: process.cwd() });
  const row = report.rows.find((r) => r.filename === manifestEntry.filename)!;
  assert.equal(row.classification, "APPLIED_CONFIRMED");
  assert.equal(row.ledgerStatus, "LEDGER_ROW_PRESENT");
});
