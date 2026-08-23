/**
 * Canonical HTML template-field contract.
 *
 * The database remains the source of truth for an administrator's mapping
 * (merge_template_fields).  A contract adds a stable, reviewable schema for a
 * first-party HTML template: which merge tokens are allowed, which are
 * mandatory for a legally useful document, and which are semantic checkbox
 * values.  It is deliberately data-only; it never contains applicant values.
 */

import { extractUniquePlaceholders } from "./placeholder-extractor.ts";

export type TemplateFieldValueKind = "text" | "date" | "checkbox" | "computed";

export interface TemplateFieldContract {
  /** Semantic merge key, without {{ }} or << >> delimiters. */
  key: string;
  label: string;
  valueKind: TemplateFieldValueKind;
  /** Required for this first-party document to be valid. */
  required: boolean;
  /** Documentation for the canonical DB mapping; rendering still uses the DB snapshot. */
  sourcePath?: string;
  optionValue?: string;
}

export interface TemplateContract {
  key: string;
  name: string;
  /** Number of intentional logical document sections, not a promise that long data cannot wrap. */
  logicalPageCount: number;
  fields: readonly TemplateFieldContract[];
}

export interface ContractValidationResult {
  valid: boolean;
  missingFromHtml: string[];
  unknownInHtml: string[];
  duplicateKeys: string[];
}

/**
 * Validate a template source against its declared schema.  This is used at
 * build/test time for first-party templates and can also be used by template
 * registration tooling.  It treats both supported placeholder syntaxes as the
 * same semantic key.
 */
export function validateTemplateContract(htmlBody: string, contract: TemplateContract): ContractValidationResult {
  const actual = new Set(extractUniquePlaceholders(htmlBody));
  const keys = contract.fields.map((field) => field.key);
  const seen = new Set<string>();
  const duplicateKeys = keys.filter((key) => {
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  const expected = new Set(keys);

  return {
    valid: duplicateKeys.length === 0 && [...expected].every((key) => actual.has(key)) && [...actual].every((key) => expected.has(key)),
    missingFromHtml: [...expected].filter((key) => !actual.has(key)).sort(),
    unknownInHtml: [...actual].filter((key) => !expected.has(key)).sort(),
    duplicateKeys: [...new Set(duplicateKeys)].sort(),
  };
}

/**
 * Contract-level required-data validation.  DB mappings may mark additional
 * fields required; callers merge this result with validateRequiredFields().
 * Checkbox fields are never required as text: an unchecked option is rendered
 * semantically as ☐ and is a valid value.
 */
export function validateContractRequiredValues(
  contract: TemplateContract | null | undefined,
  values: Record<string, string>,
): string[] {
  if (!contract) return [];
  return contract.fields
    .filter((field) => field.required && field.valueKind !== "checkbox")
    .filter((field) => !values[field.key] || values[field.key].trim() === "")
    .map((field) => field.key)
    .sort();
}

/** Contract-required keys must have an active field mapping before a job is queued. */
export function validateContractRequiredMappings(
  contract: TemplateContract | null | undefined,
  fields: readonly { placeholder: string; isOrphaned?: boolean }[],
): string[] {
  if (!contract) return [];
  const active = new Set(fields.filter((field) => !field.isOrphaned).map((field) => field.placeholder));
  return contract.fields
    .filter((field) => field.required)
    .filter((field) => !active.has(field.key))
    .map((field) => field.key)
    .sort();
}
