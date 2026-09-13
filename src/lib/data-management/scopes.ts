/**
 * WORKFORCE DATA MANAGEMENT — reset scope model + dependency-aware expansion
 * (mission sections 2-4, 23-29). Pure (no DB) — the domain graph itself is
 * data, unit-testable without touching Postgres. Actual row counts/deletes
 * live in reset-service.ts, which imports this module rather than
 * duplicating the dependency logic.
 *
 * UI NEVER sends raw table names — only one of the ResetScope values below.
 * The server always decides the actual table/dependency plan; a client
 * requesting IT_CODE can never end up touching WORKFORCE data, and a
 * client requesting WORKFORCE always gets its full, forced dependency set —
 * the client cannot opt out of a required dependent.
 *
 * TERMINOLOGY (identity contract review, 2026-09-13): this scope is named
 * IT_CODE, not FINGERPRINT — this system has no biometric fingerprint table.
 * "IT Code" (mã số công nhật, e.g. "DR0001-D") is an operational attendance/
 * day-worker assignment code stored on dw_data.it_code, mirrored to
 * worker_profiles.fingerprint_code and daily_applications.it_code (those two
 * DB column names predate this correction and are intentionally left
 * unrenamed here — renaming a live column name is a separate, out-of-scope
 * change). IT Code is NEVER the worker identity key: CCCD is.
 *
 * SCHEMA REALITY THIS IS BUILT ON (audited from src/db/schema.ts + real hard
 * FKs — grep of `REFERENCES worker_profiles`/`REFERENCES employment_sessions`
 * across migrations/*.sql and schema.sql, not guessed):
 *   - employment_sessions.worker_id  -> worker_profiles  ON DELETE RESTRICT (hard FK)
 *   - workforce_movements.worker_id  -> worker_profiles  ON DELETE RESTRICT (hard FK)
 *   - every other worker/employment-session reference in this graph
 *     (request_allocations.workerId/employmentSessionId, planning_allocations.
 *     employmentSessionId, start_date_corrections.workerId/employmentSessionId,
 *     daily_applications <- employment_sessions.dailyApplicationId) is a SOFT
 *     reference: no DB-level FK at all. Deleting daily_applications
 *     independently of employment_sessions would leave a silently dangling
 *     employment_sessions.daily_application_id with no DB error — this is
 *     exactly why daily_applications is only ever reset as part of WORKFORCE,
 *     never as a standalone RECRUITMENT_OPERATIONS-only operation (mission
 *     section 25's example list names "daily applications" under Recruitment
 *     Operations, but section 1's own mandate to verify real FK/business
 *     semantics before deleting wins over that illustrative list).
 *
 * MOVEMENTS IS DELIBERATELY NOT A STANDALONE SCOPE (mission section 27):
 * workforce_movements execution already mutated employment_sessions (end_date/
 * end_reason/end_movement_id) — deleting movement rows alone would leave
 * employment_sessions in a "resigned/transferred" state with no record of
 * why. It is only ever reset as a forced dependent of WORKFORCE, together
 * with the employment_sessions it may have mutated, so the whole subgraph
 * returns to a consistent state together.
 *
 * ATTENDANCE IS NOT A SCOPE AT ALL: this system has no attendance/timekeeping
 * table (dw_data.totalWorkDays/lastWorkDate are @deprecated and explicitly
 * documented as "hệ thống này KHÔNG phải chấm công" — not an attendance
 * system). Mission section 24 is conditional ("if attendance is separate...")
 * and that condition is false here.
 *
 * dw_data COUPLING RE-AUDIT (identity contract review, section 22): re-checked
 * whether dw_data reset should decouple from WORKFORCE. Finding: a REAL FK
 * exists — daily_applications.dw_id REFERENCES dw_data(id) ON DELETE SET
 * NULL (schema.sql:78) — so dw_data is not merely "conceptually" related to
 * Workforce, it is a genuine business dependency: the IT Code queue itself
 * (getFingerprintItCodeRows) INNER JOINs daily_applications to dw_data via
 * dw_id, and DW-import state (dwImportedAt/dwMatch) drives eligibility for
 * the IT Code queue, Meal export, and document classification. Resetting
 * dw_data alone (leaving daily_applications/worker_profiles/employment_sessions
 * intact) would silently null out dw_id, break that join, and desynchronize
 * "current workforce" state from Master DW without any record of why.
 * Conclusion: KEEP dw_data coupled inside WORKFORCE (no change) — this is a
 * real FK/business dependency, not a naming artifact.
 */

export const RESET_SCOPES = ["IT_CODE", "RECRUITMENT_OPERATIONS", "PLANNING", "WORKFORCE", "ALL_BUSINESS_DATA"] as const;
export type ResetScope = (typeof RESET_SCOPES)[number];

export function isResetScope(value: unknown): value is ResetScope {
  return typeof value === "string" && (RESET_SCOPES as readonly string[]).includes(value);
}

/** One row-affecting unit of work. DELETE_ALL_ROWS deletes every row in `table`; NULL_COLUMNS only clears specific columns (worker/master rows themselves are kept). */
export type ResetDomainKey =
  | "request_allocation_overrides"
  | "request_allocation_history"
  | "request_allocations"
  | "request_comments"
  | "request_kpi_cache"
  | "planning_allocations"
  | "start_date_corrections"
  | "workforce_movements"
  | "employment_sessions"
  | "daily_applications"
  | "worker_profiles"
  | "dw_data"
  | "planning_tasks"
  | "it_code_worker_profiles"
  | "it_code_dw_data"
  | "it_code_daily_applications";

export type ResetDomainMeta = { key: ResetDomainKey; table: string; label: string; kind: "DELETE_ALL_ROWS" | "NULL_COLUMNS" };

/** Canonical global delete order — respects the two real hard FKs (children before worker_profiles) and, beyond that, deletes soft-referencing children before the rows they softly point to (never DB-enforced, but avoids silently dangling references). */
const CANONICAL_DOMAIN_ORDER: ResetDomainKey[] = [
  "request_allocation_overrides",
  "request_allocation_history",
  "request_allocations",
  "request_comments",
  "request_kpi_cache",
  "planning_allocations",
  "start_date_corrections",
  "workforce_movements",
  "employment_sessions",
  "daily_applications",
  "worker_profiles",
  "dw_data",
  "planning_tasks",
  "it_code_worker_profiles",
  "it_code_dw_data",
  "it_code_daily_applications",
];

export const RESET_DOMAIN_META: Record<ResetDomainKey, ResetDomainMeta> = {
  request_allocation_overrides: { key: "request_allocation_overrides", table: "request_allocation_overrides", label: "Ghi đè phân bổ (Request Allocation Overrides)", kind: "DELETE_ALL_ROWS" },
  request_allocation_history: { key: "request_allocation_history", table: "request_allocation_history", label: "Lịch sử phân bổ yêu cầu", kind: "DELETE_ALL_ROWS" },
  request_allocations: { key: "request_allocations", table: "request_allocations", label: "Phân bổ lao động vào yêu cầu", kind: "DELETE_ALL_ROWS" },
  request_comments: { key: "request_comments", table: "request_comments", label: "Bình luận yêu cầu tuyển dụng", kind: "DELETE_ALL_ROWS" },
  request_kpi_cache: { key: "request_kpi_cache", table: "request_kpi_cache", label: "Cache KPI yêu cầu (dữ liệu suy ra)", kind: "DELETE_ALL_ROWS" },
  planning_allocations: { key: "planning_allocations", table: "planning_allocations", label: "Phân bổ Planning", kind: "DELETE_ALL_ROWS" },
  start_date_corrections: { key: "start_date_corrections", table: "start_date_corrections", label: "Yêu cầu điều chỉnh ngày nhận việc", kind: "DELETE_ALL_ROWS" },
  workforce_movements: { key: "workforce_movements", table: "workforce_movements", label: "Nghỉ việc / Thuyên chuyển", kind: "DELETE_ALL_ROWS" },
  employment_sessions: { key: "employment_sessions", table: "employment_sessions", label: "Employment Sessions", kind: "DELETE_ALL_ROWS" },
  daily_applications: { key: "daily_applications", table: "daily_applications", label: "Daily Application (đăng ký)", kind: "DELETE_ALL_ROWS" },
  worker_profiles: { key: "worker_profiles", table: "worker_profiles", label: "Hồ sơ lao động (Worker Profiles)", kind: "DELETE_ALL_ROWS" },
  dw_data: { key: "dw_data", table: "dw_data", label: "DW Data (Master DW)", kind: "DELETE_ALL_ROWS" },
  planning_tasks: { key: "planning_tasks", table: "planning_tasks", label: "Task Center (Planning)", kind: "DELETE_ALL_ROWS" },
  it_code_worker_profiles: { key: "it_code_worker_profiles", table: "worker_profiles", label: "IT Code / Mã số công nhật trên Hồ sơ lao động", kind: "NULL_COLUMNS" },
  it_code_dw_data: { key: "it_code_dw_data", table: "dw_data", label: "IT Code trên DW Data", kind: "NULL_COLUMNS" },
  it_code_daily_applications: { key: "it_code_daily_applications", table: "daily_applications", label: "IT Code trên Daily Application (mirror)", kind: "NULL_COLUMNS" },
};

const SCOPE_DOMAINS: Record<ResetScope, ResetDomainKey[]> = {
  IT_CODE: ["it_code_worker_profiles", "it_code_dw_data", "it_code_daily_applications"],
  RECRUITMENT_OPERATIONS: ["request_allocation_overrides", "request_allocation_history", "request_allocations", "request_comments", "request_kpi_cache"],
  PLANNING: ["planning_allocations"],
  WORKFORCE: [
    "request_allocation_overrides",
    "request_allocation_history",
    "request_allocations",
    "request_comments",
    "request_kpi_cache",
    "planning_allocations",
    "start_date_corrections",
    "workforce_movements",
    "employment_sessions",
    "daily_applications",
    "worker_profiles",
    "dw_data",
  ],
  ALL_BUSINESS_DATA: [
    "request_allocation_overrides",
    "request_allocation_history",
    "request_allocations",
    "request_comments",
    "request_kpi_cache",
    "planning_allocations",
    "start_date_corrections",
    "workforce_movements",
    "employment_sessions",
    "daily_applications",
    "worker_profiles",
    "dw_data",
    "planning_tasks",
  ],
};

export const RESET_SCOPE_LABELS: Record<ResetScope, string> = {
  IT_CODE: "Mã IT / Mã số công nhật",
  RECRUITMENT_OPERATIONS: "Tuyển dụng vận hành (Daily Application/phân bổ yêu cầu)",
  PLANNING: "Planning allocations",
  WORKFORCE: "Workforce / DW",
  ALL_BUSINESS_DATA: "Tất cả dữ liệu nghiệp vụ (Factory Reset)",
};

/** What stays untouched no matter which scope(s) are requested — surfaced in Preview's `preserved` list. Never derived from a guess: this is the exhaustive complement of every domain any scope can ever touch. */
export const RESET_PRESERVED_DOMAINS: readonly string[] = [
  "Organization (departments, organization_units)",
  "Users / Roles / Permissions (RBAC)",
  "Recruitment Request definitions (recruitment_requests)",
  "Planning period/target definitions (planning_periods, planning_targets)",
  "Planning column configuration (planning_column_configs)",
  "Document Merge templates + merge job history + issued candidate documents + consent evidence (candidate_documents, document_confirmations, candidate_access_sessions)",
  "Workflow/Rule engine configuration, notifications, branding, scheduled jobs",
  "schema_migrations (migration ledger)",
  "audit_logs (operation history — this reset itself is recorded here, never erased by it)",
];

export type ResetPlan = { requestedScopes: ResetScope[]; effectiveScopes: ResetScope[]; domains: ResetDomainMeta[] };

/**
 * Expand the caller's requested scope(s) into the full, forced dependency
 * plan. Idempotent/order-independent on the input; the output domain order
 * is always the canonical safe-delete order regardless of input order.
 */
export function expandResetScopes(requested: ResetScope[]): ResetPlan {
  const requestedSet = new Set(requested);
  const domainSet = new Set<ResetDomainKey>();

  let effectiveScopes: ResetScope[];
  if (requestedSet.has("ALL_BUSINESS_DATA")) {
    // Subsumes every other requested scope — compute domains from ALL_BUSINESS_DATA
    // alone, never unioned with a narrower scope's (already-covered) domains.
    effectiveScopes = ["ALL_BUSINESS_DATA"];
    for (const domain of SCOPE_DOMAINS.ALL_BUSINESS_DATA) domainSet.add(domain);
  } else if (requestedSet.has("WORKFORCE")) {
    effectiveScopes = ["WORKFORCE"];
    for (const domain of SCOPE_DOMAINS.WORKFORCE) domainSet.add(domain);
  } else {
    // No scope subsumes another here — keep exactly the (deduped) requested set,
    // union their domains as-is.
    effectiveScopes = RESET_SCOPES.filter((s) => requestedSet.has(s));
    for (const scope of effectiveScopes) {
      for (const domain of SCOPE_DOMAINS[scope]) domainSet.add(domain);
    }
  }

  const domains = CANONICAL_DOMAIN_ORDER.filter((d) => domainSet.has(d)).map((d) => RESET_DOMAIN_META[d]);
  return { requestedScopes: [...requestedSet], effectiveScopes, domains };
}

/** Permission key(s) required to EXECUTE a given effective scope set (mission section 8) — distinct from data_management.view, which only gates seeing the summary/preview. Callers must hold EVERY key returned (AND, not OR): requesting IT_CODE+PLANNING together requires both reset_it_code and reset_operational. */
export function permissionKeysForScopes(effectiveScopes: ResetScope[]): string[] {
  const keys = new Set<string>();
  for (const scope of effectiveScopes) {
    switch (scope) {
      case "ALL_BUSINESS_DATA":
        keys.add("data_management.factory_reset");
        break;
      case "WORKFORCE":
        keys.add("data_management.reset_workforce");
        break;
      case "IT_CODE":
        keys.add("data_management.reset_it_code");
        break;
      case "RECRUITMENT_OPERATIONS":
      case "PLANNING":
        keys.add("data_management.reset_operational");
        break;
    }
  }
  return [...keys];
}

/** Exact confirmation phrase the caller must type back, per effective scope set (mission section 9). Server-verified — a matching frontend string alone is never sufficient. */
export function requiredConfirmationPhrase(effectiveScopes: ResetScope[]): string {
  if (effectiveScopes.includes("ALL_BUSINESS_DATA")) return "RESET ALL BUSINESS DATA";
  if (effectiveScopes.includes("WORKFORCE")) return "RESET WORKFORCE DATA";
  if (effectiveScopes.length === 1 && effectiveScopes[0] === "IT_CODE") return "RESET IT CODE";
  if (effectiveScopes.length === 1 && effectiveScopes[0] === "RECRUITMENT_OPERATIONS") return "RESET RECRUITMENT OPERATIONS";
  if (effectiveScopes.length === 1 && effectiveScopes[0] === "PLANNING") return "RESET PLANNING";
  // Multiple independent non-subsuming scopes requested together (e.g. IT_CODE + PLANNING).
  return "RESET " + effectiveScopes.map((s) => RESET_SCOPE_LABELS[s]).join(" + ").toUpperCase();
}
