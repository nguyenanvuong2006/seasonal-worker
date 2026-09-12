import "server-only";
import { listAllUnits, type OrganizationUnitRow } from "@/lib/organization-units";
import { isDescendantPath, type BreadcrumbNode } from "@/lib/organization-tree";

/* ============================================================
   ORGANIZATION SEARCH — CANONICAL ENTITY RESOLUTION
   ------------------------------------------------------------
   Single source of truth for turning a user-typed organization/department
   name (full, partial, abbreviated, or reordered) into one or more real
   `organization_units` rows — the SAME table the "Cây tổ chức" admin UI
   (/admin/organization, /api/organization-units) reads. AI Copilot tools
   and any future consumer MUST go through this module instead of matching
   department/organization names independently.

   Why organization_units and not the flat `departments` table: the
   migration that created organization_units (2026-08-17) composes each
   migrated unit's `name` as `departments.deptName || ' — ' || departments.groupName`
   (when groupName is set). A display name like "Chrysanth Spray — Fast" is
   therefore only ever a literal substring of organization_units.name — it is
   NOT a substring of departments.deptName alone ("Fast" lives in the
   groupName half). Searching departments.deptName, exact or partial, can
   never find "Fast" — the bug was column choice, not comparison operator.

   Data Scope: organization_units has no native scope column. Every unit
   with a legacy_department_id bridges 1:1 back to departments.id — the
   real Data-Scope-bearing FK getUserScope() authorizes. A unit WITHOUT a
   legacy_department_id (a purely structural node an admin created in the
   tree, e.g. a future "Chrysanth" parent grouping) is authorized only if
   at least one of its descendants is authorized — otherwise a caller with
   zero visibility into a subtree could still discover its structural
   labels, which is an unnecessary (if low-value) scope leak.

   The tree is small enough to load whole in one query (listAllUnits() —
   same premise the admin UI already relies on for its client-side tree),
   so all matching/ranking/authorization happens in memory, in one call to
   listAllUnits(): no N+1, no per-keystroke query, and only the bounded
   `candidates` slice below is ever handed to the LLM.
   ============================================================ */

export type OrganizationUnitCandidate = {
  id: string;
  name: string;
  unitType: string;
  isActive: boolean;
  path: string;
  /** Root -> node inclusive. Safe to expose in full: an authorized candidate's ancestors are, by construction, themselves authorized (see authorizeUnits). */
  breadcrumb: BreadcrumbNode[];
  legacyDepartmentId: string | null;
};

export type OrganizationSearchResult = {
  query: string;
  normalizedQuery: string;
  status: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";
  /** Total matches found across the caller's authorized scope, before the result was capped to `limit`. */
  totalMatches: number;
  /** true when totalMatches > the returned candidates.length — narrow the query instead of assuming completeness. */
  truncated: boolean;
  candidates: OrganizationUnitCandidate[];
};

export type OrganizationResolution =
  | { status: "RESOLVED"; unit: OrganizationUnitCandidate; normalizedQuery: string }
  | { status: "AMBIGUOUS"; candidates: OrganizationUnitCandidate[]; normalizedQuery: string; totalMatches: number; truncated: boolean }
  | { status: "NOT_FOUND"; normalizedQuery: string; suggestions?: OrganizationUnitCandidate[] };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Unicode-normalize, strip Vietnamese diacritics, fold dash variants to spaces, drop remaining punctuation, collapse whitespace, lowercase. Never mutates stored names — comparison-only. */
export function normalizeSearchText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[—–-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(normalized: string): string[] {
  return normalized.length ? normalized.split(" ") : [];
}

function containsContiguousTokenRun(nameTokens: string[], queryTokens: string[]): boolean {
  if (queryTokens.length === 0 || queryTokens.length > nameTokens.length) return false;
  outer: for (let i = 0; i + queryTokens.length <= nameTokens.length; i++) {
    for (let j = 0; j < queryTokens.length; j++) {
      if (nameTokens[i + j] !== queryTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

/* Lower number = stronger match = ranks first (Section 7's declared order). */
const TIER_EXACT = 0;
const TIER_STARTS_WITH = 1;
const TIER_WORD_BOUNDARY = 2;
const TIER_CONTAINS = 3;
const TIER_TOKEN_SET = 4;

function matchTier(normalizedQuery: string, queryTokens: string[], normalizedName: string, nameTokens: string[]): number | null {
  if (!normalizedQuery) return null;
  if (normalizedName === normalizedQuery) return TIER_EXACT;
  if (normalizedName.startsWith(normalizedQuery)) return TIER_STARTS_WITH;
  if (containsContiguousTokenRun(nameTokens, queryTokens)) return TIER_WORD_BOUNDARY;
  if (normalizedName.includes(normalizedQuery)) return TIER_CONTAINS;
  if (queryTokens.length > 0 && queryTokens.every((t) => nameTokens.includes(t))) return TIER_TOKEN_SET;
  return null;
}

/** Authorized unit ids under `scope` (null = unrestricted). A structural unit with no legacy_department_id inherits authorization from any authorized descendant, at any depth. */
function authorizeUnits(units: OrganizationUnitRow[], scope: string[] | null): Set<string> {
  const authorized = new Set<string>();
  if (scope === null) {
    for (const u of units) authorized.add(u.id);
    return authorized;
  }
  const scopeSet = new Set(scope);
  for (const u of units) {
    if (u.legacyDepartmentId && scopeSet.has(u.legacyDepartmentId)) authorized.add(u.id);
  }
  for (const u of units) {
    if (authorized.has(u.id)) continue;
    const hasAuthorizedDescendant = units.some((v) => v.id !== u.id && authorized.has(v.id) && isDescendantPath(v.path, u.path));
    if (hasAuthorizedDescendant) authorized.add(u.id);
  }
  return authorized;
}

function buildBreadcrumb(unit: OrganizationUnitRow, byId: Map<string, OrganizationUnitRow>): BreadcrumbNode[] {
  const chain: BreadcrumbNode[] = [];
  let cur: OrganizationUnitRow | undefined = unit;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift({ id: cur.id, name: cur.name });
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

function toCandidateDTO(unit: OrganizationUnitRow, byId: Map<string, OrganizationUnitRow>): OrganizationUnitCandidate {
  return {
    id: unit.id,
    name: unit.name,
    unitType: unit.unitType,
    isActive: unit.isActive,
    path: unit.path,
    breadcrumb: buildBreadcrumb(unit, byId),
    legacyDepartmentId: unit.legacyDepartmentId,
  };
}

/**
 * Search organization units (arbitrary hierarchy depth — Location/Division/
 * Department/Section/Group/Team/...; unit_type is descriptive metadata only,
 * never a filter here) by partial/abbreviated/reordered name, scoped to the
 * caller's authorized departments. Deterministic tiered matching: exact >
 * starts-with > word-boundary/segment > contains > all-tokens-present.
 * Bounded result: never loads the whole tree into an LLM prompt un-capped.
 */
export async function searchOrganizationUnits(params: {
  query: string;
  scope: string[] | null;
  includeInactive?: boolean;
  limit?: number;
}): Promise<OrganizationSearchResult> {
  const normalizedQuery = normalizeSearchText(params.query);
  const includeInactive = params.includeInactive ?? false;
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  const allUnits = await listAllUnits();
  const byId = new Map(allUnits.map((u) => [u.id, u]));
  const eligible = includeInactive ? allUnits : allUnits.filter((u) => u.isActive);
  const authorized = authorizeUnits(eligible, params.scope);

  const queryTokens = tokenize(normalizedQuery);
  const matched: { unit: OrganizationUnitRow; tier: number }[] = [];
  if (normalizedQuery) {
    for (const unit of eligible) {
      if (!authorized.has(unit.id)) continue;
      const normalizedName = normalizeSearchText(unit.name);
      const tier = matchTier(normalizedQuery, queryTokens, normalizedName, tokenize(normalizedName));
      if (tier !== null) matched.push({ unit, tier });
    }
  }

  matched.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.unit.isActive) - Number(a.unit.isActive) ||
      a.unit.path.localeCompare(b.unit.path) ||
      a.unit.id.localeCompare(b.unit.id),
  );

  const totalMatches = matched.length;
  const truncated = totalMatches > limit;
  const limited = matched.slice(0, limit);

  const bestTier = matched.length > 0 ? matched[0].tier : null;
  const bestTierCount = bestTier === null ? 0 : matched.filter((m) => m.tier === bestTier).length;

  const status: OrganizationSearchResult["status"] = totalMatches === 0 ? "NOT_FOUND" : bestTierCount === 1 ? "RESOLVED" : "AMBIGUOUS";

  return {
    query: params.query,
    normalizedQuery,
    status,
    totalMatches,
    truncated,
    candidates: limited.map((m) => toCandidateDTO(m.unit, byId)),
  };
}

/** Discriminated-union wrapper over searchOrganizationUnits() for callers that want a single resolved id or an explicit ambiguity/not-found signal, never an overloaded empty array. */
export async function resolveOrganizationUnit(params: {
  query: string;
  scope: string[] | null;
  includeInactive?: boolean;
}): Promise<OrganizationResolution> {
  const result = await searchOrganizationUnits({ ...params, limit: MAX_LIMIT });
  if (result.status === "NOT_FOUND") return { status: "NOT_FOUND", normalizedQuery: result.normalizedQuery };
  if (result.status === "RESOLVED") return { status: "RESOLVED", unit: result.candidates[0], normalizedQuery: result.normalizedQuery };
  return {
    status: "AMBIGUOUS",
    candidates: result.candidates,
    normalizedQuery: result.normalizedQuery,
    totalMatches: result.totalMatches,
    truncated: result.truncated,
  };
}
