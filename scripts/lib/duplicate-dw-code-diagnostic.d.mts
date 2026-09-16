export type DuplicateDwCodeClassification =
  | "SAME_PERSON_DUPLICATE_REFERENCE"
  | "ACTIVE_VS_HISTORICAL"
  | "HISTORICAL_VS_HISTORICAL"
  | "DIFFERENT_ACTIVE_WORKERS"
  | "UNRESOLVED";

export type StrongIdentityBasis =
  | "NONE"
  | "SAME_NORMALIZED_CCCD"
  | "SAME_WORKER_PROFILE"
  | "SAME_CCCD_AND_WORKER_PROFILE";

export interface DuplicateDwRowSummary {
  dwRowOpaqueId: string;
  personCorrelationHash: string;
  hasWorkerProfile: boolean;
  hasActiveEmployment: boolean;
  departmentLocationLabel: string | null;
  hasItCode: boolean;
  hasActiveRequest: boolean;
  hasActivePlanning: boolean;
  isSoftDeleted: boolean;
}

export interface DuplicateDwCodeDiagnosticResult {
  targetCode: string;
  rowCount: number;
  classification: DuplicateDwCodeClassification;
  samePersonByStrongIdentity: boolean;
  strongIdentityBasis: StrongIdentityBasis;
  failClosedReason: string | null;
  rowSummaries: DuplicateDwRowSummary[];
}

export interface RawDiagnosticDbRow {
  dw_data_id: string | number;
  dw_code: string;
  dw_deleted_at?: string | Date | null;
  dw_created_at?: string | Date | null;
  raw_cccd?: string | null;
  raw_it_code?: string | null;
  worker_profile_id?: string | null;
  wp_deleted_at?: string | Date | null;
  wp_fingerprint_code?: string | null;
  current_session_id?: string | null;
  current_session_status?: string | null;
  session_end_date?: string | Date | null;
  dept_name?: string | null;
  dept_location?: string | null;
  group_name?: string | null;
  request_id?: string | null;
  planning_allocation_id?: string | null;
}

export declare const FORBIDDEN_SQL_KEYWORDS: readonly string[];
export declare const TARGETED_DIAGNOSTIC_SQL: string;

export declare function assertSelectOnlySql(sql: string): void;
export declare function normalizeCccd(cccd: string | null | undefined): string | null;
export declare function computeCorrelationHash(rawToken: string | null | undefined): string;
export declare function classifyDuplicateDwCode(
  rows: RawDiagnosticDbRow[] | unknown[],
  targetCode?: string
): DuplicateDwCodeDiagnosticResult;
export declare function formatDiagnosticSummary(result: DuplicateDwCodeDiagnosticResult): string;
