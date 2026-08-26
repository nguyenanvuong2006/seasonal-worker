/**
 * Pure, role-independent Data Scope policy.
 * null = unrestricted; [] = no department; [ids] = exactly those departments.
 */
export type DepartmentScope = string[] | null;
export type MovementScopeVisibility = "FULL" | "REDACTED_INCOMING" | "NONE";

/**
 * Explicit, role-independent Data Scope mode for UI presentation (RBAC
 * role-rename audit, Phase 5). A page must derive its access-mode banner
 * from THIS — computed purely from the resolved DepartmentScope value —
 * never from "is the session role ADMIN/HR_RECRUITER/DEPT_MANAGER" or from
 * any other role-identity/display-name guess. That kind of guess is exactly
 * what caused a non-manager role (e.g. one only ever granted DW Data
 * read access) to be mislabeled as "Chế độ Quản lý bộ phận" (Department
 * Manager mode) simply for not being ADMIN or HR_RECRUITER.
 *
 *   GLOBAL — scope === null: unrestricted, sees every department.
 *   SCOPED — scope has >= 1 department: a REAL, explicit restriction (the
 *            legitimate "Quản lý bộ phận" experience — filtered to those
 *            departments only).
 *   NONE   — scope === []: no department at all. This is NOT the same as
 *            SCOPED — it usually means Data Scope was never configured for
 *            this account, not that the account is a department manager.
 */
export type DataAccessMode = "GLOBAL" | "SCOPED" | "NONE";

export function resolveDataAccessMode(scope: DepartmentScope): DataAccessMode {
  if (scope === null) return "GLOBAL";
  return scope.length > 0 ? "SCOPED" : "NONE";
}

export function scopeAllowsDepartment(scope: DepartmentScope, departmentId: string | null | undefined): boolean {
  if (scope === null) return true;
  return Boolean(departmentId && scope.includes(departmentId));
}

export function scopeAllowsAllDepartments(scope: DepartmentScope, departmentIds: (string | null | undefined)[]): boolean {
  return scope === null || departmentIds.every((id) => scopeAllowsDepartment(scope, id));
}

export function movementScopeVisibility(
  scope: DepartmentScope,
  movementType: string,
  fromDepartmentId: string | null,
  toDepartmentId: string | null,
): MovementScopeVisibility {
  if (scope === null) return "FULL";
  if (scope.length === 0) return "NONE";
  if (scopeAllowsDepartment(scope, fromDepartmentId)) return "FULL";
  if (movementType === "transfer" && scopeAllowsDepartment(scope, toDepartmentId)) return "REDACTED_INCOMING";
  return "NONE";
}

export function canAggregateTransferOut(scope: DepartmentScope, fromDepartmentId: string | null): boolean {
  return scopeAllowsDepartment(scope, fromDepartmentId);
}

export function canAggregateTransferIn(scope: DepartmentScope, toDepartmentId: string | null): boolean {
  return scopeAllowsDepartment(scope, toDepartmentId);
}
