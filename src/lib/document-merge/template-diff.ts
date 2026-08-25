/**
 * TEMPLATE DIFF ENGINE — compare a DRAFT version (placeholder set + effective
 * mapping semantics) against a base version (usually the current PUBLISHED one)
 * so an operator sees EXACTLY what a form change affects, without remapping
 * unchanged fields.
 *
 * This is PURE and READ-ONLY: it never writes a database row, never publishes,
 * never mutates a snapshot, and never decides a mapping. It only classifies and
 * reports. The Designer UI calls it for the "Thay đổi" / "Trường dữ liệu" tabs,
 * the Safe Publish Checklist, and the Version Comparison view.
 *
 * SEMANTICS (matches PR #99 / PR #101):
 *   - a PUBLISHED version owns an immutable `mapping_snapshot` → the base
 *     mapping set is its frozen snapshot;
 *   - a DRAFT has `mapping_snapshot = []` and resolves the CURRENT non-orphaned
 *     `merge_template_fields` → that is the effective current mapping set that
 *     `publishTemplateVersion` would freeze.
 *
 * CHANGE CLASSIFICATION (per placeholder, over the union of base+current keys):
 *   - UNCHANGED        -> present in both, identical mapping semantics
 *   - ADDED            -> present in current (draft) only
 *   - REMOVED          -> present in base only
 *   - MAPPING_CHANGED  -> present in both, source semantics differ (≥1 field)
 *   - REQUIRED_CHANGED -> present in both, ONLY `isRequired` differs
 *   - ORPHANED         -> a mapping row exists for a placeholder that is NOT in
 *                         the current body (its mapping will not be used once the
 *                         new version publishes)
 *   - UNMAPPED         -> an ADDED/unchanged placeholder with NO mapping row at
 *                         all (operator must map it before publish)
 *
 * ADDRESS INVARIANTS: this module never rewrites or infers a mapping. It only
 * reads the supplied mapping semantics, so permanentAddress/residentialAddress
 * semantics are preserved exactly as given (see tests).
 */

import { extractUniquePlaceholders } from "./placeholder-extractor.ts";
import {
  FALLBACK_PLACEHOLDER_MAP,
  CUSTOM_ANSWER_PLACEHOLDER_MAP,
  SOURCE_FIELD_LABELS,
} from "./placeholder-aliases.ts";

/** The semantic, business-relevant fields of a mapping row. */
export interface MappingSemantics {
  placeholder: string;
  sourceType: string;
  sourceEntity: string | null;
  sourceField: string | null;
  sourcePath: string | null;
  optionValue: string | null;
  formatType: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
  isOrphaned?: boolean;
}

export type PlaceholderChangeKind =
  | "UNCHANGED"
  | "ADDED"
  | "REMOVED"
  | "MAPPING_CHANGED"
  | "REQUIRED_CHANGED"
  | "ORPHANED";

/** Which semantic fields differ between base and current for a match. */
export const MAPPING_SEMANTIC_FIELDS = [
  "sourceType",
  "sourceEntity",
  "sourceField",
  "sourcePath",
  "optionValue",
  "formatType",
  "fallbackValue",
  "isRequired",
] as const;
export type MappingSemanticField = (typeof MAPPING_SEMANTIC_FIELDS)[number];

export interface PlaceholderDiffItem {
  /** Placeholder semantic key (no delimiters). */
  placeholder: string;
  change: PlaceholderChangeKind;
  /** Base mapping semantics (null for a newly-added placeholder). */
  base: MappingSemantics | null;
  /** Effective current mapping semantics (null for a removed placeholder). */
  current: MappingSemantics | null;
  /** Semantic fields whose value changed (only for MAPPING_CHANGED/REQUIRED_CHANGED). */
  changedFields: MappingSemanticField[];
  /** True when the current placeholder has no mapping row at all. */
  requiresMapping: boolean;
}

export interface PlaceholderDiffSummary {
  total: number;
  unchanged: number;
  added: number;
  removed: number;
  mappingChanged: number;
  requiredChanged: number;
  orphaned: number;
  unmapped: number;
}

export interface TemplateDiffInput {
  /** Placeholders present in the base version's HTML body. */
  basePlaceholders: string[];
  /** Base version's effective mapping set (published snapshot for a PUBLISHED base). */
  baseMappings: MappingSemantics[];
  /** Placeholders present in the DRAFT's HTML body. */
  currentPlaceholders: string[];
  /** DRAFT's effective mapping set (current non-orphaned merge_template_fields). */
  currentMappings: MappingSemantics[];
}

export interface TemplateDiffResult {
  /** Per-placeholder classification, keyed by placeholder (deterministic). */
  items: Map<string, PlaceholderDiffItem>;
  summary: PlaceholderDiffSummary;
  /** Placeholders that need operator attention before publish (ADDED+UNMAPPED, UNMAPPED, ORPHANED). */
  needsAttention: string[];
}

/** Extract the unique placeholder set from a canonical HTML body. */
export function extractPlaceholderSet(htmlBody: string): string[] {
  return extractUniquePlaceholders(htmlBody ?? "");
}

/** Normalise an arbitrary mapping row to the semantic shape used by the diff. */
export function toMappingSemantics(row: Record<string, unknown>): MappingSemantics {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  return {
    placeholder: str(row.placeholder) ?? "",
    sourceType: str(row.sourceType) ?? "CORE_FIELD",
    sourceEntity: str(row.sourceEntity),
    sourceField: str(row.sourceField),
    sourcePath: str(row.sourcePath),
    optionValue: str(row.optionValue),
    formatType: str(row.formatType),
    fallbackValue: str(row.fallbackValue),
    isRequired: bool(row.isRequired, false),
    isOrphaned: typeof row.isOrphaned === "boolean" ? row.isOrphaned : false,
  };
}

/** Compare two equal-keyed mappings; returns the semantic fields that differ. */
export function compareMappingSemantics(
  base: MappingSemantics,
  current: MappingSemantics,
): MappingSemanticField[] {
  const changed: MappingSemanticField[] = [];
  for (const field of MAPPING_SEMANTIC_FIELDS) {
    if ((base[field] ?? "") !== (current[field] ?? "")) changed.push(field);
  }
  return changed;
}

/** Deterministic placeholder-order comparator (sort by key). */
function sortKeys(values: Iterable<string>): string[] {
  return Array.from(values).sort();
}

/**
 * Build the diff between a base version and a DRAFT.
 *
 * Deterministic regardless of input ordering: the output is keyed by placeholder
 * and iterated in sorted order, and every classification depends only on the
 * placeholder's own presence + semantics, never on array order.
 */
export function buildTemplateDiff(input: TemplateDiffInput): TemplateDiffResult {
  const baseSet = new Set(input.basePlaceholders);
  const currentSet = new Set(input.currentPlaceholders);
  const baseMap = new Map(input.baseMappings.map((m) => [m.placeholder, m]));
  const currentMap = new Map(input.currentMappings.map((m) => [m.placeholder, m]));

  const allKeys = new Set<string>([...baseSet, ...currentSet]);
  // ORPHANED: mapping rows whose placeholder is not in the current body.
  for (const placeholder of currentMap.keys()) {
    if (!currentSet.has(placeholder)) allKeys.add(placeholder);
  }

  const items = new Map<string, PlaceholderDiffItem>();
  const summary: PlaceholderDiffSummary = {
    total: 0,
    unchanged: 0,
    added: 0,
    removed: 0,
    mappingChanged: 0,
    requiredChanged: 0,
    orphaned: 0,
    unmapped: 0,
  };
  const needsAttention: string[] = [];

  for (const placeholder of sortKeys(allKeys)) {
    const inBase = baseSet.has(placeholder);
    const inCurrent = currentSet.has(placeholder);
    const base = baseMap.get(placeholder) ?? null;
    const current = currentMap.get(placeholder) ?? null;
    // For a placeholder present in the body, mapped = has a non-orphaned mapping row.
    const currentMapped =
      current !== null && current.isOrphaned !== true && (current.sourcePath || current.sourceField || current.fallbackValue);
    const baseMapped =
      base !== null && base.isOrphaned !== true && (base.sourcePath || base.sourceField || base.fallbackValue);

    let change: PlaceholderChangeKind;
    let changedFields: MappingSemanticField[] = [];

    if (!inCurrent && inBase) {
      change = "REMOVED";
    } else if (inCurrent && !inBase) {
      change = "ADDED";
    } else if (inCurrent && inBase) {
      const diffs = base && current ? compareMappingSemantics(base, current) : [];
      if (diffs.length === 0) {
        change = "UNCHANGED";
      } else if (diffs.length === 1 && diffs[0] === "isRequired") {
        change = "REQUIRED_CHANGED";
        changedFields = diffs;
      } else {
        change = "MAPPING_CHANGED";
        changedFields = diffs;
      }
    } else if (!inCurrent && !inBase && current !== null) {
      // Mapping row for a placeholder absent from the body -> orphaned for the new form.
      change = "ORPHANED";
    } else {
      // Fallback (should not reach here).
      change = "UNCHANGED";
    }

    // Any placeholder present in the current (draft) body that has no source at
    // all still needs operator attention before publish — regardless of change kind.
    const requiresMapping = inCurrent && !currentMapped;

    items.set(placeholder, { placeholder, change, base, current, changedFields, requiresMapping });

    summary.total += 1;
    switch (change) {
      case "UNCHANGED":
        summary.unchanged += 1;
        break;
      case "ADDED":
        summary.added += 1;
        break;
      case "REMOVED":
        summary.removed += 1;
        break;
      case "MAPPING_CHANGED":
        summary.mappingChanged += 1;
        break;
      case "REQUIRED_CHANGED":
        summary.requiredChanged += 1;
        break;
      case "ORPHANED":
        summary.orphaned += 1;
        needsAttention.push(placeholder);
        break;
    }
    if (requiresMapping && (change !== "ORPHANED")) {
      summary.unmapped += 1;
      needsAttention.push(placeholder);
    }
  }

  return { items, summary, needsAttention };
}

/** A deterministic, non-destructive suggestion for an ADDED placeholder. */
export interface MappingSuggestion {
  placeholder: string;
  /** Proposed source field (the record key / sourcePath). */
  sourceField: string;
  /** Operator-facing label of the source field. */
  sourceLabel: string;
  /** sourceType to propose (CORE_FIELD for record fields, DYNAMIC_ANSWER for custom answers). */
  sourceType: "CORE_FIELD" | "DYNAMIC_ANSWER";
  confidence: "high" | "medium";
  /** How the suggestion was derived: a built-in deterministic alias. */
  basis: "alias";
}

/**
 * Suggest a mapping for an ADDED placeholder from the EXISTING deterministic
 * alias tables. Returns null when there is no deterministic alias — the caller
 * must then either ask the operator directly or consult the fuzzy auto-mapping
 * engine (auto-mapping.ts); this module NEVER silently commits a suggestion.
 *
 * It is non-destructive: it returns data only.
 */
export function suggestDeterministicMapping(placeholder: string): MappingSuggestion | null {
  const clean = placeholder.trim();
  if (!clean) return null;

  const recordField = FALLBACK_PLACEHOLDER_MAP[clean];
  if (recordField) {
    return {
      placeholder: clean,
      sourceField: recordField,
      sourceLabel: SOURCE_FIELD_LABELS[recordField] ?? recordField,
      sourceType: "CORE_FIELD",
      confidence: "high",
      basis: "alias",
    };
  }

  const customField = CUSTOM_ANSWER_PLACEHOLDER_MAP[clean];
  if (customField) {
    return {
      placeholder: clean,
      sourceField: customField,
      sourceLabel: SOURCE_FIELD_LABELS[customField] ?? customField,
      sourceType: "DYNAMIC_ANSWER",
      confidence: "high",
      basis: "alias",
    };
  }

  return null;
}

/** Business-friendly label for a sourcePath (presentation only; never mutates a mapping). */
export function sourceFieldLabel(sourcePath: string | null | undefined): string {
  if (!sourcePath) return "—";
  return SOURCE_FIELD_LABELS[sourcePath] ?? sourcePath;
}
