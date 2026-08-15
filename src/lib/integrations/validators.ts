import type { IntegrationRecordMeta, RecruitmentDemand } from "./types.ts";

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateIntegrationMeta(meta: IntegrationRecordMeta): ValidationResult {
  const errors: string[] = [];
  if (!meta.sourceSystem.trim()) errors.push("sourceSystem is required");
  if (!meta.externalRecordId.trim()) errors.push("externalRecordId is required");
  if (!DATE_RE.test(meta.effectiveFrom)) errors.push("effectiveFrom must be YYYY-MM-DD");
  if (meta.effectiveTo && !DATE_RE.test(meta.effectiveTo)) errors.push("effectiveTo must be YYYY-MM-DD or null");
  if (meta.effectiveTo && meta.effectiveTo < meta.effectiveFrom) errors.push("effectiveTo must not precede effectiveFrom");
  if (Number.isNaN(Date.parse(meta.lastUpdatedAt))) errors.push("lastUpdatedAt must be ISO-8601");
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateRecruitmentDemand(record: RecruitmentDemand): ValidationResult {
  const base = validateIntegrationMeta(record);
  const errors = base.ok ? [] : [...base.errors];
  if (!record.departmentId) errors.push("canonical departmentId is required; text department names are not accepted as keys");
  if (!record.externalRequestId.trim()) errors.push("externalRequestId is required");
  if (!record.logicalDemandKey.trim()) errors.push("logicalDemandKey is required for cross-source de-duplication");
  for (const [key, value] of Object.entries({
    requiredMale: record.requiredMale,
    requiredFemale: record.requiredFemale,
    requiredTotal: record.requiredTotal,
  })) {
    if (!Number.isInteger(value) || value < 0) errors.push(`${key} must be a non-negative integer`);
  }
  if (record.requiredMale + record.requiredFemale > 0 && record.requiredTotal !== record.requiredMale + record.requiredFemale) {
    errors.push("requiredTotal must equal requiredMale + requiredFemale when gender demand is provided");
  }
  if (record.status === "APPROVED" && !record.approvedAt) errors.push("approvedAt is required for APPROVED demand");
  return errors.length ? { ok: false, errors } : { ok: true };
}
