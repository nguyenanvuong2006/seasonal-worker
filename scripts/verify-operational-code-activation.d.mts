export interface PostActivationVerificationResult {
  conflictsZero: boolean;
  poolPopulated: boolean;
  dwActiveAssignmentsExist: boolean;
  protectedCodesNotAvailable: boolean;
  noDuplicateDwActive: boolean;
  noDuplicateItActive: boolean;
  drNextSequenceSafe: boolean;
  details: {
    conflictsCount?: number;
    dwCodesCount?: number;
    dwActiveAssignmentsCount?: number;
    availableProtectedCount?: number;
    totalProtectedCodes?: number;
    duplicateActiveDwCodes?: number;
    duplicateActiveItCodes?: number;
    drNextSequence?: number;
  };
}

export function verifyOperationalCodeActivation(options: {
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
  commitSha?: string | null;
}): Promise<PostActivationVerificationResult>;
