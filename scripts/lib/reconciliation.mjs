/**
 * READ-ONLY RECONCILIATION ENGINE (Mission B section 6).
 * ------------------------------------------------------------
 * Cross-references migration files (via scripts/migration-manifest.mjs +
 * scripts/lib/migration-inventory.mjs), the schema_migrations ledger (when
 * bootstrapped), and live schema evidence (via scripts/lib/schema-probes.mjs)
 * to classify every migration file. Every function here is read-only — no
 * writes anywhere, ever.
 *
 * Classification vocabulary (sections 2, 19, 21):
 *   APPLIED_CONFIRMED         — ledger row exists, checksum matches the
 *                                current file's bytes.
 *   LEDGER_CHECKSUM_MISMATCH  — ledger row exists, but its checksum does
 *                                NOT match the current file's bytes (section
 *                                7's hard-error case — the file changed
 *                                after being applied, or migration_id
 *                                collided). Always the highest-risk
 *                                classification; never silently resolved.
 *   TOMBSTONED                — manifest says tombstoned=true. Not executed.
 *   SUPERSEDED                — manifest sets supersededBy and no ledger row
 *                                exists (a ledger row always wins — it means
 *                                this exact file really was applied/recorded
 *                                despite being superseded going forward).
 *   SCHEMA_PRESENT_UNLEDGERED — no ledger row, but every structural object
 *                                this migration is supposed to have created
 *                                is present. Section 21: "not auto-APPLIED".
 *   NOT_APPLIED_CONFIRMED     — no ledger row, and NONE of the migration's
 *                                structural objects are present (strong
 *                                structural evidence of absence).
 *   UNKNOWN                   — no ledger row, and structural evidence is
 *                                either partial (some but not all objects
 *                                present) or unavailable (pure data-only
 *                                migration with nothing structural to
 *                                probe). Section 19: "UNKNOWN is acceptable.
 *                                The objective is to eliminate UNKNOWN over
 *                                time safely, not lie."
 *
 * Risk vocabulary (section 20), assigned only to UNKNOWN / NOT_APPLIED_CONFIRMED
 * (and always CRITICAL_APP_DEPENDENCY for LEDGER_CHECKSUM_MISMATCH, the most
 * dangerous state): CRITICAL_APP_DEPENDENCY | ACTIVE_FEATURE_DEPENDENCY | LEGACY.
 * Resolved classifications (APPLIED_CONFIRMED, SCHEMA_PRESENT_UNLEDGERED,
 * SUPERSEDED, TOMBSTONED) carry risk "NONE".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_MANIFEST } from "../migration-manifest.mjs";
import { checkInventoryDrift } from "./migration-inventory.mjs";
import { schemaMigrationsTableExists, listLedgerRows, computeChecksum } from "./migration-ledger.mjs";
import { tableExists, columnExists, indexExists, constraintExists, functionExists, triggerExists, extensionExists, viewExists } from "./schema-probes.mjs";

const STRUCTURAL_KINDS = new Set(["table", "column", "index", "constraint", "function", "trigger", "extension", "view"]);

/**
 * Parses one manifest objectsCreatedOrModified entry, e.g.
 * "column:users.session_version" or "index:foo(DROPPED)" or
 * "index:bar(conditional)". Returns null for non-structural entries
 * (row:/rows:/data: — data-level assertions, never probed structurally
 * per section 6's "prefer structural evidence" / avoid business data values).
 */
export function parseObjectRef(raw) {
  const colonIdx = raw.indexOf(":");
  if (colonIdx === -1) return null;
  const kind = raw.slice(0, colonIdx);
  if (!STRUCTURAL_KINDS.has(kind)) return null;

  let rest = raw.slice(colonIdx + 1);
  let suffix = null;
  const parenIdx = rest.indexOf("(");
  if (parenIdx !== -1 && rest.endsWith(")")) {
    suffix = rest.slice(parenIdx + 1, -1);
    rest = rest.slice(0, parenIdx);
  }

  // DROPPED means the migration REMOVES this object — expect it ABSENT.
  // "conditional" objects are created only under a data-cleanliness
  // precondition checked at migration time (see e.g.
  // employment_session_one_active_uq) — probed for information, but never
  // counted toward pass/fail since their absence doesn't prove non-application.
  const expect = suffix === "DROPPED" ? "absent" : suffix === "conditional" ? "informational" : "present";

  return { kind, identifier: rest, expect, label: raw };
}

async function probeExistence(client, kind, identifier) {
  switch (kind) {
    case "table":
      return tableExists(client, identifier);
    case "column": {
      const dot = identifier.indexOf(".");
      return columnExists(client, identifier.slice(0, dot), identifier.slice(dot + 1));
    }
    case "index":
      return indexExists(client, identifier);
    case "constraint":
      return constraintExists(client, identifier);
    case "function":
      return functionExists(client, identifier);
    case "trigger":
      return triggerExists(client, identifier);
    case "extension":
      return extensionExists(client, identifier);
    case "view":
      return viewExists(client, identifier);
    default:
      throw new Error(`probeExistence: unknown structural kind "${kind}"`);
  }
}

/**
 * Probes every structural object a manifest entry lists. Returns per-object
 * results plus a required-only tally (informational objects excluded from
 * the tally, per parseObjectRef's doc above).
 */
export async function computeStructuralEvidence(client, objectsCreatedOrModified) {
  const checks = [];
  let requiredTotal = 0;
  let requiredSatisfied = 0;

  for (const raw of objectsCreatedOrModified) {
    const ref = parseObjectRef(raw);
    if (!ref) continue; // non-structural (row:/rows:/data:) — not probed
    const exists = await probeExistence(client, ref.kind, ref.identifier);
    const ok = ref.expect === "absent" ? !exists : exists;
    checks.push({ label: ref.label, kind: ref.kind, expect: ref.expect, exists, ok });
    if (ref.expect !== "informational") {
      requiredTotal += 1;
      if (ok) requiredSatisfied += 1;
    }
  }

  return { checks, requiredTotal, requiredSatisfied };
}

function deriveRisk(classification, appDependency) {
  if (classification === "LEDGER_CHECKSUM_MISMATCH") return "CRITICAL_APP_DEPENDENCY";
  if (classification !== "UNKNOWN" && classification !== "NOT_APPLIED_CONFIRMED") return "NONE";
  if (appDependency === "REQUIRED") return "CRITICAL_APP_DEPENDENCY";
  if (appDependency === "OPTIONAL") return "ACTIVE_FEATURE_DEPENDENCY";
  return "LEGACY";
}

/**
 * Classifies one migration. `ledgerRow` is the schema_migrations row for
 * this migration_id (or null). `ledgerBootstrapped` distinguishes "ledger
 * table doesn't exist yet" from "ledger exists but has no row for this
 * migration" for reporting purposes only — both take the same "no ledger
 * row" branch below, since the classification logic is identical either way.
 */
export function classifyMigration({ manifestEntry, currentChecksum, ledgerRow, structuralEvidence }) {
  if (ledgerRow) {
    if (ledgerRow.checksum_sha256 === currentChecksum) {
      return { classification: "APPLIED_CONFIRMED", risk: "NONE" };
    }
    return { classification: "LEDGER_CHECKSUM_MISMATCH", risk: deriveRisk("LEDGER_CHECKSUM_MISMATCH", manifestEntry.appDependency) };
  }

  if (manifestEntry.tombstoned) {
    return { classification: "TOMBSTONED", risk: "NONE" };
  }
  if (manifestEntry.supersededBy) {
    return { classification: "SUPERSEDED", risk: "NONE" };
  }

  const { requiredTotal, requiredSatisfied } = structuralEvidence;
  let classification;
  if (requiredTotal === 0) {
    classification = "UNKNOWN"; // pure data-only migration — nothing structural to probe
  } else if (requiredSatisfied === requiredTotal) {
    classification = "SCHEMA_PRESENT_UNLEDGERED";
  } else if (requiredSatisfied === 0) {
    classification = "NOT_APPLIED_CONFIRMED";
  } else {
    classification = "UNKNOWN"; // partial evidence — cannot prove either way
  }

  return { classification, risk: deriveRisk(classification, manifestEntry.appDependency) };
}

function resolveRepoRoot(root) {
  return root ?? process.cwd();
}

/**
 * Full reconciliation pass. Returns:
 *   { ledgerBootstrapped, drift: {filesWithoutManifestEntry, manifestEntriesWithoutFile}, rows: [...] }
 * `rows` has one entry per manifest migration:
 *   { filename, ledgerStatus, classification, risk, structuralEvidence, notes }
 * Never throws for missing schema objects (that's the whole point); only
 * propagates genuine DB/query errors or a filesystem read failure for a
 * migration file that should exist but doesn't.
 */
export async function reconcileMigrations(client, { root } = {}) {
  const repoRoot = resolveRepoRoot(root);
  const drift = checkInventoryDrift({ root: repoRoot });
  const ledgerBootstrapped = await schemaMigrationsTableExists(client);
  const ledgerRows = ledgerBootstrapped ? await listLedgerRows(client) : [];
  const ledgerByFilename = new Map(ledgerRows.map((r) => [r.migration_id, r]));

  const rows = [];
  for (const manifestEntry of MIGRATION_MANIFEST) {
    // A manifest entry whose file is missing on disk (drift) cannot be
    // checksummed or probed — surface it as its own explicit state rather
    // than crashing the whole reconciliation pass.
    if (drift.manifestEntriesWithoutFile.includes(manifestEntry.filename)) {
      rows.push({
        filename: manifestEntry.filename,
        ledgerStatus: ledgerBootstrapped ? (ledgerByFilename.has(manifestEntry.filename) ? "LEDGER_ROW_PRESENT" : "NO_LEDGER_ROW") : "LEDGER_NOT_BOOTSTRAPPED",
        classification: "FILE_MISSING_ON_DISK",
        risk: "CRITICAL_APP_DEPENDENCY",
        structuralEvidence: null,
        notes: "Manifest entry exists but migrations/ file is missing on disk — inventory drift, see checkInventoryDrift().",
      });
      continue;
    }

    const filePath = join(repoRoot, "migrations", manifestEntry.filename);
    const currentChecksum = computeChecksum(readFileSync(filePath));
    const ledgerRow = ledgerByFilename.get(manifestEntry.filename) ?? null;
    const structuralEvidence = await computeStructuralEvidence(client, manifestEntry.objectsCreatedOrModified);
    const { classification, risk } = classifyMigration({ manifestEntry, currentChecksum, ledgerRow, structuralEvidence });

    rows.push({
      filename: manifestEntry.filename,
      ledgerStatus: ledgerBootstrapped ? (ledgerRow ? "LEDGER_ROW_PRESENT" : "NO_LEDGER_ROW") : "LEDGER_NOT_BOOTSTRAPPED",
      classification,
      risk,
      structuralEvidence,
      notes: manifestEntry.notes,
    });
  }

  return { ledgerBootstrapped, drift, rows };
}
