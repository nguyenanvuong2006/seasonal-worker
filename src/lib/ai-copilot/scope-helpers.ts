/**
 * AI COPILOT — pure Data Scope intersection helpers shared by every tool.
 * No "server-only", no DB — directly unit-testable (node:test), mirroring
 * data-scope.ts's own pure/no-DB convention.
 *
 * The repo-wide 3-way convention (see data-scope.ts, resolveDataAccessMode):
 *   scope === null      -> unrestricted (GLOBAL)
 *   scope.length === 0  -> sees nothing (NONE) — never a fallback to "all"
 *   scope = [ids...]    -> exactly those departments (SCOPED)
 *
 * A tool's `args` may narrow WITHIN the session's own scope (e.g. "only
 * department X") but must NEVER be able to widen it. intersectDepartmentFilter
 * is the single place that enforces this — every tool that accepts an
 * optional departmentId argument MUST route it through this function
 * instead of trusting the argument directly.
 */

export type DepartmentFilterResult =
  | { ok: true; departmentIds: string[] | null }
  | { ok: false; reason: "OUT_OF_SCOPE" };

export function intersectDepartmentFilter(
  scope: string[] | null,
  requestedDepartmentId: string | null | undefined,
): DepartmentFilterResult {
  const requested = requestedDepartmentId?.trim() || null;
  if (scope === null) {
    return { ok: true, departmentIds: requested ? [requested] : null };
  }
  if (!requested) {
    return { ok: true, departmentIds: scope };
  }
  if (!scope.includes(requested)) {
    return { ok: false, reason: "OUT_OF_SCOPE" };
  }
  return { ok: true, departmentIds: [requested] };
}

/** Clamp a model/caller-requested page size into a safe, deterministic range. */
export function capLimit(requested: unknown, max: number, fallback: number): number {
  const n = typeof requested === "number" && Number.isFinite(requested) ? Math.floor(requested) : fallback;
  if (n <= 0) return fallback;
  return Math.min(n, max);
}
