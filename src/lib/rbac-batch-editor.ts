/**
 * BATCH PERMISSION EDITOR — pure, dependency-free dirty-state logic.
 * ---------------------------------------------------------------------
 * Extracted out of the /admin/permissions page so the local dirty-state
 * model (toggle -> local state only, never a network write; compute what
 * changed; bulk-enable/disable with the protected-key safety net; build
 * the batch payload) is unit-testable without rendering React.
 *
 * Convention: a permission map is `Map<permissionKey, allowed>`. A key
 * absent from the map means "not configured" and is treated as `false`
 * (fail-closed) — same convention `hasPermission()` already uses server-side.
 */

export type PermissionMap = Map<string, boolean>;

export function effectiveAllowed(map: PermissionMap, key: string): boolean {
  return map.get(key) ?? false;
}

/** Every permissionKey whose draft value differs from baseline (fail-closed compare). */
export function computeChangedKeys(baseline: PermissionMap, draft: PermissionMap): string[] {
  const keys = new Set([...baseline.keys(), ...draft.keys()]);
  return [...keys].filter((k) => effectiveAllowed(draft, k) !== effectiveAllowed(baseline, k)).sort();
}

/** Toggle exactly one key in `draft`, returning a NEW map (never mutates the input). */
export function toggleOne(draft: PermissionMap, key: string): PermissionMap {
  const next = new Map(draft);
  next.set(key, !effectiveAllowed(draft, key));
  return next;
}

export type BulkEnableResult = { next: PermissionMap; excluded: string[] };

/**
 * Apply "Bật cả nhóm"/"Bật tất cả" (allowed=true) or "Tắt cả nhóm"/"Tắt tất cả"
 * (allowed=false) to `keys` within `draft`. When enabling, any key present in
 * `protectedKeys` is silently excluded from THIS bulk action (never swept
 * into "enable everything") and reported back in `excluded` so the caller
 * can tell the admin why. Disabling has no such exclusion — revoking a
 * capability is never unsafe. An admin can still grant a protected key
 * individually via `toggleOne`.
 */
export function applyBulk(draft: PermissionMap, keys: string[], allowed: boolean, protectedKeys: ReadonlySet<string>): BulkEnableResult {
  const excluded = allowed ? keys.filter((k) => protectedKeys.has(k)) : [];
  const applied = allowed ? keys.filter((k) => !protectedKeys.has(k)) : keys;
  const next = new Map(draft);
  for (const k of applied) next.set(k, allowed);
  return { next, excluded };
}

/** Restore `draft` to exactly `baseline` (Cancel) — a fresh copy, never a shared reference. */
export function resetToBaseline(baseline: PermissionMap): PermissionMap {
  return new Map(baseline);
}

export type PermissionChange = { permissionKey: string; allowed: boolean };

/** Build the batch payload from exactly what changed — never the full permission set. */
export function buildBatchChanges(baseline: PermissionMap, draft: PermissionMap): PermissionChange[] {
  return computeChangedKeys(baseline, draft).map((permissionKey) => ({ permissionKey, allowed: effectiveAllowed(draft, permissionKey) }));
}

/**
 * Shared "leaving the editor" guard for BOTH role switching and tab
 * switching: a confirmation is required exactly when the destination is
 * actually different AND there is unsaved dirty state. Switching to the
 * SAME target (e.g. re-clicking the already-selected role) is a no-op and
 * must never pop a confirmation, and a clean (non-dirty) editor must never
 * interfere with normal navigation.
 */
export function shouldConfirmDiscard(current: string, next: string, isDirty: boolean): boolean {
  return current !== next && isDirty;
}
