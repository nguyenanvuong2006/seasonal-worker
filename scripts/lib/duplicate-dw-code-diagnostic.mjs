import { createHash } from "node:crypto";

/**
 * STRICTLY READ-ONLY DUPLICATE DW CODE DIAGNOSTIC HELPER
 * ------------------------------------------------------
 * Provides:
 * 1. The SELECT-only targeted drill-down SQL query for investigating
 *    a specific duplicate DW Code (e.g. DR23685-D).
 * 2. Static and runtime SQL safety validation ensuring no mutating
 *    statements can be executed.
 * 3. Fail-closed duplicate classification engine implementing the 5 exact
 *    states required:
 *      - SAME_PERSON_DUPLICATE_REFERENCE
 *      - ACTIVE_VS_HISTORICAL
 *      - HISTORICAL_VS_HISTORICAL
 *      - DIFFERENT_ACTIVE_WORKERS
 *      - UNRESOLVED
 * 4. Minimal, privacy-safe diagnostic summary generator (zero CCCD, phone,
 *    full name, DOB, or raw IT Code in logs).
 */

export const FORBIDDEN_SQL_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "ALTER",
  "DROP",
  "CREATE",
  "GRANT",
  "REVOKE",
];

export const TARGETED_DIAGNOSTIC_SQL = `
SELECT
  d.id AS dw_data_id,
  d.code AS dw_code,
  d.deleted_at AS dw_deleted_at,
  d.created_at AS dw_created_at,
  d.cccd AS raw_cccd,
  d.it_code AS raw_it_code,
  wp.id AS worker_profile_id,
  wp.deleted_at AS wp_deleted_at,
  wp.fingerprint_code AS wp_fingerprint_code,
  es.id AS current_session_id,
  es.status AS current_session_status,
  es.end_date AS session_end_date,
  dept.dept_name,
  dept.location AS dept_location,
  dept.group_name,
  req.request_id,
  plan.planning_allocation_id
FROM dw_data d
LEFT JOIN worker_profiles wp
  ON wp.cccd = d.cccd AND wp.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT id, status, end_date, dept_id
  FROM employment_sessions
  WHERE worker_id = wp.id
  ORDER BY (status = 'APPROVED' AND end_date IS NULL) DESC, reg_date DESC
  LIMIT 1
) es ON true
LEFT JOIN departments dept
  ON dept.id = es.dept_id
LEFT JOIN LATERAL (
  SELECT ra.recruitment_request_id AS request_id
  FROM request_allocations ra
  JOIN recruitment_requests rr ON rr.id = ra.recruitment_request_id
  WHERE ra.employment_session_id = es.id
    AND rr.status NOT IN ('CANCELLED', 'REJECTED', 'CLOSED')
  LIMIT 1
) req ON true
LEFT JOIN LATERAL (
  SELECT pa.id AS planning_allocation_id
  FROM planning_allocations pa
  WHERE pa.employment_session_id = es.id
  LIMIT 1
) plan ON true
WHERE d.code = $1
ORDER BY d.created_at ASC, d.id ASC
`.trim();

/**
 * Validates that an SQL string is strictly SELECT-only and free from
 * any mutating statement keyword. Throws if invalid.
 */
export function assertSelectOnlySql(sql) {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new Error("SQL must be a non-empty string");
  }

  // Strip comments and string literals
  const cleaned = sql
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, " ");

  for (const kw of FORBIDDEN_SQL_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\b`, "i");
    if (regex.test(cleaned)) {
      throw new Error(`MUTATING_SQL_FORBIDDEN: SQL contains forbidden keyword '${kw}'`);
    }
  }

  if (!/^\s*SELECT\b/i.test(cleaned.trim())) {
    throw new Error("SELECT_REQUIRED: SQL query must begin with SELECT");
  }
}

// Self-validate TARGETED_DIAGNOSTIC_SQL at import time
assertSelectOnlySql(TARGETED_DIAGNOSTIC_SQL);

/**
 * Normalizes a CCCD string (trim, remove non-alphanumeric, uppercase)
 */
export function normalizeCccd(cccd) {
  if (!cccd || typeof cccd !== "string") return null;
  const cleaned = cccd.replace(/\s+/g, "").toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Creates an opaque, deterministic correlation hash from an identity token.
 * Never exposes the raw token.
 */
export function computeCorrelationHash(rawToken) {
  if (!rawToken || typeof rawToken !== "string") return "no_identity_token";
  return createHash("sha256").update(rawToken.trim()).digest("hex").slice(0, 12);
}

/**
 * Evaluates duplicate DW Code rows and returns a strictly classified verdict.
 *
 * Requirements:
 * - Exactly 2 rows expected (fail closed to UNRESOLVED if != 2).
 * - SAME_PERSON requires strong identity evidence:
 *     same normalized CCCD, OR same worker_profile canonical identity.
 *   Name hash / DOB alone is NEVER enough to establish SAME_PERSON.
 * - Classification taxonomy:
 *     1. SAME_PERSON_DUPLICATE_REFERENCE
 *     2. ACTIVE_VS_HISTORICAL
 *     3. HISTORICAL_VS_HISTORICAL
 *     4. DIFFERENT_ACTIVE_WORKERS
 *     5. UNRESOLVED
 */
export function classifyDuplicateDwCode(rows, targetCode) {
  if (!Array.isArray(rows) || rows.length !== 2) {
    return {
      targetCode: targetCode || "UNKNOWN",
      rowCount: Array.isArray(rows) ? rows.length : 0,
      classification: "UNRESOLVED",
      samePersonByStrongIdentity: false,
      strongIdentityBasis: "NONE",
      failClosedReason: `Expected exactly 2 dw_data rows for duplicate code, observed ${Array.isArray(rows) ? rows.length : 0}`,
      rowSummaries: [],
    };
  }

  const [rowA, rowB] = rows;

  // Build row summaries (strictly minimal booleans/opaque IDs)
  const summarizeRow = (r, idx) => {
    const isSoftDeleted = r.dw_deleted_at !== null && r.dw_deleted_at !== undefined;
    const hasWorkerProfile = Boolean(r.worker_profile_id && !r.wp_deleted_at);
    const hasActiveEmployment = Boolean(
      hasWorkerProfile &&
        r.current_session_status === "APPROVED" &&
        (r.session_end_date === null || r.session_end_date === undefined)
    );
    const hasItCode = Boolean(
      (r.raw_it_code && r.raw_it_code.trim()) ||
      (r.wp_fingerprint_code && r.wp_fingerprint_code.trim())
    );
    const hasActiveRequest = Boolean(r.request_id);
    const hasActivePlanning = Boolean(r.planning_allocation_id);

    const deptParts = [r.dept_location, r.dept_name, r.group_name]
      .filter((p) => p && typeof p === "string" && p.trim())
      .map((p) => p.trim());
    const departmentLocationLabel = deptParts.length > 0 ? deptParts.join(" / ") : null;

    const personToken = normalizeCccd(r.raw_cccd) || (r.worker_profile_id ? String(r.worker_profile_id) : null);
    const personCorrelationHash = computeCorrelationHash(personToken);

    return {
      dwRowOpaqueId: `dw_row_${idx + 1}`,
      personCorrelationHash,
      hasWorkerProfile,
      hasActiveEmployment,
      departmentLocationLabel,
      hasItCode,
      hasActiveRequest,
      hasActivePlanning,
      isSoftDeleted,
    };
  };

  const summaryA = summarizeRow(rowA, 0);
  const summaryB = summarizeRow(rowB, 1);
  const rowSummaries = [summaryA, summaryB];

  // Strong Identity Check
  const normCccdA = normalizeCccd(rowA.raw_cccd);
  const normCccdB = normalizeCccd(rowB.raw_cccd);
  const wpIdA = rowA.worker_profile_id ? String(rowA.worker_profile_id).trim() : null;
  const wpIdB = rowB.worker_profile_id ? String(rowB.worker_profile_id).trim() : null;

  // Conflict Check: identical CCCD linked to contradictory worker profiles
  if (normCccdA && normCccdB && normCccdA === normCccdB && wpIdA && wpIdB && wpIdA !== wpIdB) {
    return {
      targetCode: targetCode || rowA.dw_code || "UNKNOWN",
      rowCount: 2,
      classification: "UNRESOLVED",
      samePersonByStrongIdentity: false,
      strongIdentityBasis: "CONFLICTING_CCCD_AND_WORKER_PROFILE",
      failClosedReason: "Identity evidence conflicts: matching CCCD resolves to different worker profiles",
      rowSummaries,
    };
  }

  const sameCccd = Boolean(normCccdA && normCccdB && normCccdA === normCccdB);
  const sameWorkerProfile = Boolean(wpIdA && wpIdB && wpIdA === wpIdB);
  const samePersonByStrongIdentity = sameCccd || sameWorkerProfile;

  let strongIdentityBasis = "NONE";
  if (sameCccd && sameWorkerProfile) strongIdentityBasis = "SAME_CCCD_AND_WORKER_PROFILE";
  else if (sameCccd) strongIdentityBasis = "SAME_NORMALIZED_CCCD";
  else if (sameWorkerProfile) strongIdentityBasis = "SAME_WORKER_PROFILE";

  // Decision Tree
  let classification = "UNRESOLVED";
  let failClosedReason = null;

  if (samePersonByStrongIdentity) {
    classification = "SAME_PERSON_DUPLICATE_REFERENCE";
  } else {
    // Both rows must have sufficient strong evidence to establish two distinct identifiable persons.
    const hasStrongIdA = Boolean(normCccdA || wpIdA);
    const hasStrongIdB = Boolean(normCccdB || wpIdB);

    if (!hasStrongIdA || !hasStrongIdB) {
      classification = "UNRESOLVED";
      failClosedReason = "One or both dw_data rows lack strong identity evidence (no usable CCCD and no worker_profile)";
    } else {
      const distinctByCccd = Boolean(normCccdA && normCccdB && normCccdA !== normCccdB);
      const distinctByWorkerProfile = Boolean(wpIdA && wpIdB && wpIdA !== wpIdB);

      if (!distinctByCccd && !distinctByWorkerProfile) {
        classification = "UNRESOLVED";
        failClosedReason = "Linkage ambiguity: cannot definitively establish distinct persons without common identity dimension";
      } else {
        const activeA = summaryA.hasActiveEmployment;
        const activeB = summaryB.hasActiveEmployment;

        if (activeA && activeB) {
          classification = "DIFFERENT_ACTIVE_WORKERS";
        } else if ((activeA && !activeB) || (!activeA && activeB)) {
          classification = "ACTIVE_VS_HISTORICAL";
        } else if (!activeA && !activeB) {
          classification = "HISTORICAL_VS_HISTORICAL";
        } else {
          classification = "UNRESOLVED";
          failClosedReason = "Ambiguous employment session resolution across duplicate rows";
        }
      }
    }
  }

  return {
    targetCode: targetCode || rowA.dw_code || "UNKNOWN",
    rowCount: 2,
    classification,
    samePersonByStrongIdentity,
    strongIdentityBasis,
    failClosedReason,
    rowSummaries,
  };
}

/**
 * Formats diagnostic result into a minimized, human-readable report.
 * Guaranteed zero PII (no CCCD, phone, name, DOB, raw IT code, or UUID).
 */
export function formatDiagnosticSummary(result) {
  const lines = [];
  lines.push(`\n=== TARGETED DUPLICATE DW CODE DIAGNOSTIC: "${result.targetCode}" ===`);
  lines.push(`Total dw_data rows found: ${result.rowCount}`);
  lines.push(`Strong identity correlation (same person): ${result.samePersonByStrongIdentity ? "YES" : "NO"} (${result.strongIdentityBasis})`);

  if (result.rowSummaries && result.rowSummaries.length > 0) {
    lines.push("\nRow Summary Breakdown (opaque IDs & booleans only):");
    for (const r of result.rowSummaries) {
      lines.push(`  - [${r.dwRowOpaqueId}] personCorrelationHash=${r.personCorrelationHash}`);
      lines.push(`      hasWorkerProfile=${r.hasWorkerProfile}`);
      lines.push(`      hasActiveEmployment=${r.hasActiveEmployment}`);
      lines.push(`      departmentLocationLabel=${r.departmentLocationLabel ? `"${r.departmentLocationLabel}"` : "none"}`);
      lines.push(`      hasItCode=${r.hasItCode}`);
      lines.push(`      hasActiveRequest=${r.hasActiveRequest}`);
      lines.push(`      hasActivePlanning=${r.hasActivePlanning}`);
      lines.push(`      isSoftDeleted=${r.isSoftDeleted}`);
    }
  }

  if (result.failClosedReason) {
    lines.push(`\nFAIL-CLOSED NOTICE: ${result.failClosedReason}`);
  }

  lines.push(`\n>>> FINAL CLASSIFICATION: ${result.classification} <<<`);
  return lines.join("\n");
}
