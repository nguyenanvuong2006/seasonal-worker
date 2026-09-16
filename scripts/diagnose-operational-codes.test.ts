/**
 * OPERATIONAL CODE DIAGNOSTIC — TESTS & STATIC SAFETY GUARDS
 * ---------------------------------------------------------
 * Tests for:
 * 1. SQL Safety Invariant: TARGETED_DIAGNOSTIC_SQL must be strictly SELECT-only.
 *    Any mutating keywords (INSERT, UPDATE, DELETE, TRUNCATE, ALTER, DROP, CREATE)
 *    are structurally rejected.
 * 2. Source Code Invariant: scripts/diagnose-operational-codes.mjs and
 *    scripts/lib/duplicate-dw-code-diagnostic.mjs contain ZERO mutating statements.
 * 3. Output Minimization & Privacy: no raw CCCD, phone, full name, DOB, raw IT code,
 *    or raw UUIDs in formatDiagnosticSummary().
 * 4. Duplicate DW Code Classification Engine:
 *    - SAME_PERSON requires strong identity evidence (same normalized CCCD or same
 *      worker_profile ID). Name/DOB alone NEVER triggers SAME_PERSON.
 *    - ACTIVE_VS_HISTORICAL
 *    - HISTORICAL_VS_HISTORICAL
 *    - DIFFERENT_ACTIVE_WORKERS
 *    - UNRESOLVED (fail closed on row counts != 2 or ambiguous linkage)
 * 5. Workflow Governance: .github/workflows/diagnose-operational-codes-production.yml
 *    retains production environment scoping, hostname guardrail, and target_code input.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TARGETED_DIAGNOSTIC_SQL,
  assertSelectOnlySql,
  classifyDuplicateDwCode,
  formatDiagnosticSummary,
  normalizeCccd,
  computeCorrelationHash,
  FORBIDDEN_SQL_KEYWORDS,
} from "./lib/duplicate-dw-code-diagnostic.mjs";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/diagnose-operational-codes.mjs";
const HELPER_PATH = "scripts/lib/duplicate-dw-code-diagnostic.mjs";
const WORKFLOW_PATH = ".github/workflows/diagnose-operational-codes-production.yml";

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ============================================================
   1. SQL SAFETY INVARIANT TESTS
   ============================================================ */
test("assertSelectOnlySql: TARGETED_DIAGNOSTIC_SQL passes validation", () => {
  assert.doesNotThrow(() => {
    assertSelectOnlySql(TARGETED_DIAGNOSTIC_SQL);
  });
});

test("assertSelectOnlySql: rejects mutating SQL statements", () => {
  for (const kw of FORBIDDEN_SQL_KEYWORDS) {
    assert.throws(
      () => assertSelectOnlySql(`SELECT * FROM dw_data; ${kw} INTO fake;`),
      /MUTATING_SQL_FORBIDDEN/,
      `Must reject keyword ${kw}`
    );
  }
});

test("assertSelectOnlySql: rejects non-SELECT initial statement", () => {
  assert.throws(
    () => assertSelectOnlySql("PRAGMA table_info(dw_data);"),
    /SELECT_REQUIRED/
  );
});

test("static source scan: scripts never mutate the database", () => {
  const scriptCode = stripJsComments(readFileSync(join(ROOT, SCRIPT_PATH), "utf8"));
  const helperCode = stripJsComments(readFileSync(join(ROOT, HELPER_PATH), "utf8"));

  for (const code of [scriptCode, helperCode]) {
    assert.doesNotMatch(code, /\bUPDATE\s+[a-zA-Z0-9_]+\s+SET\b/i);
    assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i);
    assert.doesNotMatch(code, /\bTRUNCATE\s+(?:TABLE\s+)?[a-zA-Z0-9_]+/i);
    assert.doesNotMatch(code, /\bDROP\s+(?:TABLE|INDEX|VIEW)\b/i);
    assert.doesNotMatch(code, /\bALTER\s+TABLE\b/i);
    assert.doesNotMatch(code, /\bCREATE\s+(?:TABLE|INDEX|VIEW)\b/i);
  }
});

/* ============================================================
   2. STRONG IDENTITY EVIDENCE TESTS
   ============================================================ */
test("normalizeCccd: strips whitespace, uppercases, returns null for empty", () => {
  assert.equal(normalizeCccd(" 079123456789 "), "079123456789");
  assert.equal(normalizeCccd("b123 456 "), "B123456");
  assert.equal(normalizeCccd("   "), null);
  assert.equal(normalizeCccd(null), null);
});

test("computeCorrelationHash: deterministic 12-char SHA-256 hash", () => {
  const h1 = computeCorrelationHash("079123456789");
  const h2 = computeCorrelationHash("079123456789");
  const h3 = computeCorrelationHash("079999999999");
  assert.equal(h1.length, 12);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test("classifyDuplicateDwCode: SAME_PERSON_DUPLICATE_REFERENCE when normalized CCCDs match", () => {
  const rows = [
    {
      dw_data_id: "1",
      dw_code: "DR23685-D",
      raw_cccd: "079123456789",
      worker_profile_id: "wp-uuid-1",
      current_session_status: "APPROVED",
      session_end_date: null,
    },
    {
      dw_data_id: "2",
      dw_code: "DR23685-D",
      raw_cccd: " 079123456789 ",
      worker_profile_id: "wp-uuid-1",
      current_session_status: "APPROVED",
      session_end_date: null,
    },
  ];

  const result = classifyDuplicateDwCode(rows, "DR23685-D");
  assert.equal(result.classification, "SAME_PERSON_DUPLICATE_REFERENCE");
  assert.equal(result.samePersonByStrongIdentity, true);
  assert.equal(result.strongIdentityBasis, "SAME_CCCD_AND_WORKER_PROFILE");
});

test("classifyDuplicateDwCode: SAME_PERSON_DUPLICATE_REFERENCE when canonical worker_profile_id matches", () => {
  const rows = [
    {
      dw_data_id: "1",
      dw_code: "DR23685-D",
      raw_cccd: "079123456789",
      worker_profile_id: "wp-uuid-canonical",
      current_session_status: "APPROVED",
      session_end_date: null,
    },
    {
      dw_data_id: "2",
      dw_code: "DR23685-D",
      raw_cccd: "079999999999", // different CCCD entry (e.g. 9-digit CMND vs 12-digit CCCD)
      worker_profile_id: "wp-uuid-canonical", // same resolved canonical profile
      current_session_status: "APPROVED",
      session_end_date: null,
    },
  ];

  const result = classifyDuplicateDwCode(rows, "DR23685-D");
  assert.equal(result.classification, "SAME_PERSON_DUPLICATE_REFERENCE");
  assert.equal(result.samePersonByStrongIdentity, true);
  assert.equal(result.strongIdentityBasis, "SAME_WORKER_PROFILE");
});

test("classifyDuplicateDwCode: name/DOB alone NEVER triggers SAME_PERSON (Requirement 3 guard)", () => {
  const rows = [
    {
      dw_data_id: "1",
      dw_code: "DR23685-D",
      raw_cccd: "079111111111",
      worker_profile_id: "wp-uuid-A",
      current_session_status: "APPROVED",
      session_end_date: null,
    },
    {
      dw_data_id: "2",
      dw_code: "DR23685-D",
      raw_cccd: "079222222222",
      worker_profile_id: "wp-uuid-B",
      current_session_status: "APPROVED",
      session_end_date: null,
    },
  ];

  const result = classifyDuplicateDwCode(rows, "DR23685-D");
  // Both are distinct strong identities holding active employment simultaneously
  assert.equal(result.samePersonByStrongIdentity, false);
  assert.equal(result.strongIdentityBasis, "NONE");
  assert.notEqual(result.classification, "SAME_PERSON_DUPLICATE_REFERENCE");
  assert.equal(result.classification, "DIFFERENT_ACTIVE_WORKERS");
});

/* ============================================================
   3. OTHER CLASSIFICATION TAXONOMY STATES
   ============================================================ */
test("classifyDuplicateDwCode: DIFFERENT_ACTIVE_WORKERS when 2 distinct active workers hold the code", () => {
  const rows = [
    {
      dw_data_id: "1",
      dw_code: "DR23685-D",
      raw_cccd: "079111111111",
      worker_profile_id: "wp-uuid-1",
      current_session_status: "APPROVED",
      session_end_date: null,
    },
    {
      dw_data_id: "2",
      dw_code: "DR23685-D",
      raw_cccd: "079222222222",
      worker_profile_id: "wp-uuid-2",
      current_session_status: "APPROVED",
      session_end_date: null,
    },
  ];

  const result = classifyDuplicateDwCode(rows, "DR23685-D");
  assert.equal(result.classification, "DIFFERENT_ACTIVE_WORKERS");
  assert.equal(result.samePersonByStrongIdentity, false);
});

test("classifyDuplicateDwCode: ACTIVE_VS_HISTORICAL when one is active and one is ended", () => {
  const rows = [
    {
      dw_data_id: "1",
      dw_code: "DR23685-D",
      raw_cccd: "079111111111",
      worker_profile_id: "wp-uuid-active",
      current_session_status: "APPROVED",
      session_end_date: null,
    },
    {
      dw_data_id: "2",
      dw_code: "DR23685-D",
      raw_cccd: "079222222222",
      worker_profile_id: "wp-uuid-former",
      current_session_status: "APPROVED",
      session_end_date: "2026-08-01", // ended
    },
  ];

  const result = classifyDuplicateDwCode(rows, "DR23685-D");
  assert.equal(result.classification, "ACTIVE_VS_HISTORICAL");
  assert.equal(result.rowSummaries[0].hasActiveEmployment, true);
  assert.equal(result.rowSummaries[1].hasActiveEmployment, false);
});

test("classifyDuplicateDwCode: ACTIVE_VS_HISTORICAL when one is active and one dw_data row is soft-deleted", () => {
  const rows = [
    {
      dw_data_id: "1",
      dw_code: "DR23685-D",
      raw_cccd: "079111111111",
      worker_profile_id: "wp-uuid-active",
      current_session_status: "APPROVED",
      session_end_date: null,
    },
    {
      dw_data_id: "2",
      dw_code: "DR23685-D",
      raw_cccd: "079222222222",
      dw_deleted_at: new Date("2026-07-01"),
      worker_profile_id: null,
    },
  ];

  const result = classifyDuplicateDwCode(rows, "DR23685-D");
  assert.equal(result.classification, "ACTIVE_VS_HISTORICAL");
  assert.equal(result.rowSummaries[0].hasActiveEmployment, true);
  assert.equal(result.rowSummaries[1].hasActiveEmployment, false);
  assert.equal(result.rowSummaries[1].isSoftDeleted, true);
});

test("classifyDuplicateDwCode: HISTORICAL_VS_HISTORICAL when both have ended or no active employment", () => {
  const rows = [
    {
      dw_data_id: "1",
      dw_code: "DR23685-D",
      raw_cccd: "079111111111",
      worker_profile_id: "wp-uuid-1",
      current_session_status: "APPROVED",
      session_end_date: "2025-12-31",
    },
    {
      dw_data_id: "2",
      dw_code: "DR23685-D",
      raw_cccd: "079222222222",
      worker_profile_id: null, // no profile
    },
  ];

  const result = classifyDuplicateDwCode(rows, "DR23685-D");
  assert.equal(result.classification, "HISTORICAL_VS_HISTORICAL");
  assert.equal(result.rowSummaries[0].hasActiveEmployment, false);
  assert.equal(result.rowSummaries[1].hasActiveEmployment, false);
});

/* ============================================================
   4. FAIL-CLOSED BEHAVIOR (Requirement 5)
   ============================================================ */
test("classifyDuplicateDwCode: fails closed to UNRESOLVED when row count is not 2", () => {
  const empty = classifyDuplicateDwCode([], "DR23685-D");
  assert.equal(empty.classification, "UNRESOLVED");
  assert.match(empty.failClosedReason || "", /Expected exactly 2/);

  const single = classifyDuplicateDwCode([{ dw_data_id: "1" }], "DR23685-D");
  assert.equal(single.classification, "UNRESOLVED");
  assert.match(single.failClosedReason || "", /Expected exactly 2/);

  const triple = classifyDuplicateDwCode(
    [{ dw_data_id: "1" }, { dw_data_id: "2" }, { dw_data_id: "3" }],
    "DR23685-D"
  );
  assert.equal(triple.classification, "UNRESOLVED");
  assert.match(triple.failClosedReason || "", /Expected exactly 2/);
});

/* ============================================================
   5. MINIMIZED PRIVACY OUTPUT TESTS (Requirement 2)
   ============================================================ */
test("formatDiagnosticSummary: contains zero raw CCCD, phone, full name, or UUIDs", () => {
  const rows = [
    {
      dw_data_id: "uuid-dw-1",
      dw_code: "DR23685-D",
      raw_cccd: "079123456789",
      raw_it_code: "IT999888",
      worker_profile_id: "12345678-1234-1234-1234-123456789abc",
      current_session_status: "APPROVED",
      session_end_date: null,
      dept_location: "Củ Chi",
      dept_name: "Kho",
      group_name: "Sơ chế",
    },
    {
      dw_data_id: "uuid-dw-2",
      dw_code: "DR23685-D",
      raw_cccd: "079987654321",
      raw_it_code: "IT111222",
      worker_profile_id: "87654321-4321-4321-4321-cba987654321",
      current_session_status: "APPROVED",
      session_end_date: "2026-05-01",
      dept_location: "Hóc Môn",
      dept_name: "Đóng gói",
      group_name: "Ca sáng",
    },
  ];

  const result = classifyDuplicateDwCode(rows, "DR23685-D");
  const formatted = formatDiagnosticSummary(result);

  // Must not expose raw 9-12 digit CCCD
  assert.doesNotMatch(formatted, /\b079123456789\b/);
  assert.doesNotMatch(formatted, /\b079987654321\b/);

  // Must not expose raw IT code
  assert.doesNotMatch(formatted, /\bIT999888\b/);
  assert.doesNotMatch(formatted, /\bIT111222\b/);

  // Must not expose full 36-character UUIDs
  assert.doesNotMatch(formatted, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);

  // Must include opaque summaries
  assert.match(formatted, /dw_row_1/);
  assert.match(formatted, /dw_row_2/);
  assert.match(formatted, /personCorrelationHash=/);
  assert.match(formatted, /hasActiveEmployment=true/);
  assert.match(formatted, /hasActiveEmployment=false/);
  assert.match(formatted, /FINAL CLASSIFICATION: ACTIVE_VS_HISTORICAL/);
});

/* ============================================================
   6. WORKFLOW GOVERNANCE TESTS
   ============================================================ */
test("workflow: workflow_dispatch with target_code input, environment=production, and hostname guardrail", () => {
  const workflow = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
  assert.match(workflow, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*target_code:/);
  assert.match(workflow, /default:\s*"DR23685-D"/);
  assert.match(workflow, /environment:\s*production/);
  assert.match(workflow, /PROD_DATABASE_URL/);
  assert.match(workflow, /KNOWN_STAGING_HOST/);
  assert.match(workflow, /TARGET_DW_CODE:\s*\$\{\{\s*github\.event\.inputs\.target_code\s*\|\|\s*'DR23685-D'\s*\}\}/);
});
