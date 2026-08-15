/**
 * STANDARD WORKFORCE INTEGRATION CONTRACTS
 * ----------------------------------------
 * These are transport/runtime contracts, not persistence models. A connector must
 * map external organization keys to canonical internal IDs before analytics sees a
 * record. Display names are never join keys.
 */

export type KnownSourceSystem =
  | "SEASONAL_WORKER"
  | "RECRUITMENT_REQUEST"
  | "ATS"
  | "HRIS"
  | "ATTENDANCE"
  | "WORKFORCE_MOVEMENT"
  | "PLANNING";

export type SourceSystem = KnownSourceSystem | (string & {});
export type ExternalEntityType = "location" | "division" | "department" | "section" | "group" | "position";

export type IntegrationRecordMeta = {
  sourceSystem: SourceSystem;
  externalRecordId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  lastUpdatedAt: string;
};

/**
 * Canonical organization reference. `departmentId` is available today through
 * departments.id. The other IDs are nullable until their canonical masters are
 * introduced by a real connector; they must never be replaced by text joins.
 */
export type CanonicalOrganizationRef = {
  locationId: string | null;
  divisionId: string | null;
  departmentId: string;
  sectionId: string | null;
  groupId: string | null;
  positionId: string | null;
  display?: {
    location?: string;
    division?: string;
    department?: string;
    section?: string;
    group?: string;
    position?: string;
  };
};

export type ExternalSystemMapping = {
  sourceSystem: SourceSystem;
  entityType: ExternalEntityType;
  externalId: string;
  internalId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  lastUpdatedAt: string;
};

export type RecruitmentDemandStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "CANCELLED" | "CLOSED";
export type RecruitmentDemandPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

/** Future Recruitment Request contract. Only APPROVED records may become demand. */
export type RecruitmentDemand = IntegrationRecordMeta &
  CanonicalOrganizationRef & {
    externalRequestId: string;
    requiredMale: number;
    requiredFemale: number;
    requiredTotal: number;
    priority: RecruitmentDemandPriority;
    requestReason: string | null;
    status: RecruitmentDemandStatus;
    requestedAt: string;
    approvedAt: string | null;
    updatedAt: string;
    /** Stable cross-source business key used by source-of-truth de-duplication. */
    logicalDemandKey: string;
    /** Optional ID/key of a demand record this record explicitly replaces. */
    supersedesDemandKey: string | null;
  };

export type AtsPipelineStage = "APPLIED" | "SCREENED" | "SHORTLISTED" | "INTERVIEW" | "OFFERED" | "ACCEPTED" | "ONBOARDING" | "EXPECTED_START";

export type RecruitmentPipelineSnapshot = IntegrationRecordMeta &
  CanonicalOrganizationRef & {
    asOfDate: string;
    stages: Record<AtsPipelineStage, number>;
    /** Only populated when probabilities are backed by an approved historical model. */
    probabilityWeightedSupply: number | null;
    historicalModelVersion: string | null;
  };

export type WorkforceSupplyEventType =
  | "CONFIRMED_INCOMING"
  | "EXPECTED_RETURNING"
  | "EXPECTED_EXIT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";

export type WorkforceSupplyEvent = IntegrationRecordMeta &
  CanonicalOrganizationRef & {
    eventType: WorkforceSupplyEventType;
    quantity: number;
    certainty: "CONFIRMED" | "EXPECTED" | "ESTIMATED";
  };

export type IntegrationSourceStatus = {
  sourceSystem: SourceSystem;
  status: "CURRENT" | "DEGRADED" | "STALE" | "UNAVAILABLE";
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  message: string | null;
};

export type IntegrationBatch<T> = {
  source: IntegrationSourceStatus;
  records: T[];
  receivedAt: string;
};

/** Connector boundary. Connectors return contracts; they never call analytics directly. */
export interface WorkforceConnector<T> {
  readonly sourceSystem: SourceSystem;
  validate(records: unknown[]): { valid: T[]; errors: { index: number; message: string }[] };
  normalize(records: T[], mappings: ExternalSystemMapping[]): T[];
}
